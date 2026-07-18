use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::StreamExt;
use reqwest::header::CONTENT_TYPE;
use serde_json::{json, Map, Value};
use tauri::Window;

use super::native_transport::{
    apply_provider_headers, checked_response, emit_chunks, endpoint_with_version, parse_json,
    response_text, SseDecoder, STREAM_IDLE_TIMEOUT,
};
use super::openai_compatible::{map_provider_error, ProviderChatChunkKind, ProviderRequestError};
use super::reasoning::{
    apply_message_replay, apply_provider_request_fields, apply_reasoning_selection,
    capture_replay_payloads, ProviderReasoningSelection,
};
use super::retry::{can_retry_transport, is_retryable_transport_error, notify_and_wait_for_retry};
use super::types::{ProviderModelRecord, ProviderResolvedModel, ProviderSecretRecord};

const TOOL_CALL_ID_PREFIX: &str = "wizzle-google";

pub async fn complete_chat(
    client: &reqwest::Client,
    window: &Window,
    request_id: &str,
    model: &ProviderResolvedModel,
    body: Value,
    reasoning_selection: Option<&ProviderReasoningSelection>,
) -> Result<String, String> {
    let request_body = build_request_body(model, &body, reasoning_selection)?;
    let mut attempt = 0;

    loop {
        match post_generate_content(client, model, &request_body, false).await {
            Ok(response) => match response_text(response).await {
                Ok(body) => return normalize_completion(&body),
                Err(error) if error.retryable && can_retry_transport(attempt, false) => {
                    attempt += 1;
                    notify_and_wait_for_retry(window, request_id, attempt, &error.message).await;
                }
                Err(error) => return Err(error.message),
            },
            Err(error) if error.retryable && can_retry_transport(attempt, false) => {
                attempt += 1;
                notify_and_wait_for_retry(window, request_id, attempt, &error.message).await;
            }
            Err(error) => return Err(error.message),
        }
    }
}

pub async fn stream_chat(
    client: &reqwest::Client,
    window: Window,
    request_id: &str,
    model: &ProviderResolvedModel,
    body: Value,
    reasoning_selection: Option<&ProviderReasoningSelection>,
) -> Result<(), String> {
    let request_body = build_request_body(model, &body, reasoning_selection)?;
    let mut attempt = 0;
    let mut emitted_any = false;

    'retry: loop {
        let response = match post_generate_content(client, model, &request_body, true).await {
            Ok(response) => response,
            Err(error) if error.retryable && can_retry_transport(attempt, emitted_any) => {
                attempt += 1;
                notify_and_wait_for_retry(&window, request_id, attempt, &error.message).await;
                continue;
            }
            Err(error) => return Err(error.message),
        };
        let mut decoder = SseDecoder::default();
        let mut stream = response.bytes_stream();
        let mut state = GoogleStreamState::default();

        loop {
            let item = match tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next()).await {
                Ok(item) => item,
                Err(_) if can_retry_transport(attempt, emitted_any) => {
                    attempt += 1;
                    notify_and_wait_for_retry(
                        &window,
                        request_id,
                        attempt,
                        "Provider stream timed out while waiting for data.",
                    )
                    .await;
                    continue 'retry;
                }
                Err(_) => {
                    return Err("Provider stream timed out while waiting for data.".to_string())
                }
            };
            let Some(item) = item else { break };
            let bytes = match item {
                Ok(bytes) => bytes,
                Err(error)
                    if is_retryable_transport_error(&error)
                        && can_retry_transport(attempt, emitted_any) =>
                {
                    let mapped = map_provider_error(None, "", Some(&error));
                    attempt += 1;
                    notify_and_wait_for_retry(&window, request_id, attempt, &mapped.message).await;
                    continue 'retry;
                }
                Err(error) => return Err(map_provider_error(None, "", Some(&error)).message),
            };
            for event in decoder.append(&bytes)? {
                let chunks = process_stream_event(&event.data, &mut state, model)?;
                emitted_any |= emit_chunks(&window, request_id, chunks)? > 0;
            }
        }
        for event in decoder.finish()? {
            let chunks = process_stream_event(&event.data, &mut state, model)?;
            emitted_any |= emit_chunks(&window, request_id, chunks)? > 0;
        }

        let stream_incomplete = !state.finished;
        match resolve_stream(state, emitted_any) {
            Ok(()) => return Ok(()),
            Err(error) if stream_incomplete && can_retry_transport(attempt, emitted_any) => {
                attempt += 1;
                notify_and_wait_for_retry(&window, request_id, attempt, &error).await;
            }
            Err(error) => return Err(error),
        }
    }
}

async fn post_generate_content(
    client: &reqwest::Client,
    model: &ProviderResolvedModel,
    body: &Value,
    stream: bool,
) -> Result<reqwest::Response, ProviderRequestError> {
    let model_id = model.model.model_id.trim_start_matches("models/");
    if model_id.is_empty()
        || model_id.contains(':')
        || model_id.contains('?')
        || model_id.contains('#')
    {
        return Err(ProviderRequestError::new(
            "Google model ID is invalid.".to_string(),
            false,
        ));
    }
    let operation = if stream {
        "streamGenerateContent?alt=sse"
    } else {
        "generateContent"
    };
    let path = format!("models/{model_id}:{operation}");
    let request = client
        .post(endpoint_with_version(
            &model.provider.endpoint,
            "v1beta",
            &path,
        ))
        .header(CONTENT_TYPE, "application/json")
        .json(body);
    let request = apply_provider_headers(request, &model.provider)?
        .send()
        .await;

    checked_response(request).await
}

fn build_request_body(
    model: &ProviderResolvedModel,
    body: &Value,
    reasoning_selection: Option<&ProviderReasoningSelection>,
) -> Result<Value, String> {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Provider request is missing messages.".to_string())?;
    let mut system_parts = Vec::new();
    let mut contents = Vec::new();
    let mut tool_names = std::collections::HashMap::new();

    for message in messages {
        match message.get("role").and_then(Value::as_str) {
            Some("system") => {
                let text = message
                    .get("content")
                    .map(content_as_text)
                    .unwrap_or_default();
                if !text.is_empty() {
                    system_parts.push(json!({ "text": text }));
                }
            }
            Some("user") => push_content(
                &mut contents,
                "user",
                google_content_parts(message.get("content"))?,
            ),
            Some("assistant") => {
                let mut parts = google_content_parts(message.get("content"))?;
                if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                    for tool_call in tool_calls {
                        let id = tool_call
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let function = tool_call.get("function").and_then(Value::as_object);
                        let name = function
                            .and_then(|value| value.get("name"))
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if id.is_empty() || name.is_empty() {
                            return Err("A stored tool call is missing its id or name.".to_string());
                        }
                        let args = parse_arguments(
                            function
                                .and_then(|value| value.get("arguments"))
                                .and_then(Value::as_str)
                                .unwrap_or("{}"),
                        )?;
                        tool_names.insert(id.to_string(), name.to_string());
                        let metadata = decode_tool_call_metadata(id);
                        let mut function_call = json!({ "name": name, "args": args });
                        if let Some(native_id) = metadata.native_id {
                            function_call["id"] = Value::String(native_id);
                        }
                        let mut part = json!({ "functionCall": function_call });
                        if let Some(signature) = metadata.signature {
                            part["thoughtSignature"] = Value::String(signature);
                        }
                        parts.push(part);
                    }
                }
                let mut converted_content = json!({ "role": "model", "parts": parts });
                apply_message_replay(message, &mut converted_content)?;
                push_converted_content(&mut contents, converted_content);
            }
            Some("tool") => {
                let id = message
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let name = tool_names.get(id).ok_or_else(|| {
                    "A stored Google tool result does not match a preceding tool call.".to_string()
                })?;
                let text = message
                    .get("content")
                    .map(content_as_text)
                    .unwrap_or_default();
                let response = serde_json::from_str::<Value>(&text)
                    .ok()
                    .filter(Value::is_object)
                    .unwrap_or_else(|| json!({ "result": text }));
                let mut function_response = json!({ "name": name, "response": response });
                if let Some(native_id) = decode_tool_call_metadata(id).native_id {
                    function_response["id"] = Value::String(native_id);
                }
                push_content(
                    &mut contents,
                    "user",
                    vec![json!({ "functionResponse": function_response })],
                );
            }
            Some(_) | None => {}
        }
    }

    if contents.is_empty() {
        return Err("Provider request contains no usable messages.".to_string());
    }
    let mut output = json!({ "contents": contents });
    let object = output.as_object_mut().expect("request object");
    if !system_parts.is_empty() {
        object.insert(
            "systemInstruction".to_string(),
            json!({ "parts": system_parts }),
        );
    }

    let mut generation_config = Map::new();
    if let Some(value) = body
        .get("max_tokens")
        .and_then(Value::as_u64)
        .or(model.model.max_output_tokens)
    {
        generation_config.insert("maxOutputTokens".to_string(), Value::from(value.max(1)));
    }
    copy_number(body, &mut generation_config, "temperature", "temperature");
    copy_number(body, &mut generation_config, "top_p", "topP");
    if !generation_config.is_empty() {
        object.insert(
            "generationConfig".to_string(),
            Value::Object(generation_config),
        );
    }

    let tool_choice = body.get("tool_choice").and_then(Value::as_str);
    if let Some(tools) = convert_tools(body.get("tools")) {
        if !tools.is_empty() && tool_choice != Some("none") {
            object.insert(
                "tools".to_string(),
                json!([{ "functionDeclarations": tools }]),
            );
            object.insert(
                "toolConfig".to_string(),
                json!({ "functionCallingConfig": { "mode": "AUTO" } }),
            );
        }
    }
    apply_provider_request_fields(&mut output, &model.provider.request_fields)?;
    apply_reasoning_selection(
        &mut output,
        model.model.reasoning.as_ref(),
        reasoning_selection,
    )?;
    Ok(output)
}

fn google_content_parts(content: Option<&Value>) -> Result<Vec<Value>, String> {
    let Some(content) = content else {
        return Ok(Vec::new());
    };
    if let Some(text) = content.as_str() {
        return Ok(if text.is_empty() {
            Vec::new()
        } else {
            vec![json!({ "text": text })]
        });
    }
    let mut parts = Vec::new();
    for part in content.as_array().into_iter().flatten() {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = part
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    parts.push(json!({ "text": text }));
                }
            }
            Some("image_url") => {
                let url = part
                    .pointer("/image_url/url")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "An image attachment is missing its URL.".to_string())?;
                let (mime_type, data) = parse_data_url(url).ok_or_else(|| {
                    "Google Gemini image attachments must be base64 data URLs.".to_string()
                })?;
                parts.push(json!({ "inlineData": { "mimeType": mime_type, "data": data } }));
            }
            _ => {}
        }
    }
    Ok(parts)
}

fn parse_data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (metadata, data) = rest.split_once(',')?;
    let mime_type = metadata.strip_suffix(";base64")?;
    if mime_type.is_empty() || data.is_empty() {
        None
    } else {
        Some((mime_type, data))
    }
}

fn content_as_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn push_content(contents: &mut Vec<Value>, role: &str, parts: Vec<Value>) {
    if parts.is_empty() {
        return;
    }
    if let Some(previous) = contents.last_mut() {
        if previous.get("role").and_then(Value::as_str) == Some(role) {
            if let Some(existing) = previous.get_mut("parts").and_then(Value::as_array_mut) {
                existing.extend(parts);
                return;
            }
        }
    }
    contents.push(json!({ "role": role, "parts": parts }));
}

fn push_converted_content(contents: &mut Vec<Value>, content: Value) {
    let role = content.get("role").and_then(Value::as_str);
    let has_replay_fields = content.as_object().is_some_and(|object| {
        object
            .keys()
            .any(|key| !matches!(key.as_str(), "role" | "parts"))
    });
    if !has_replay_fields {
        if let (Some(role), Some(parts)) = (
            role,
            content.get("parts").and_then(Value::as_array).cloned(),
        ) {
            push_content(contents, role, parts);
            return;
        }
    }
    contents.push(content);
}

fn parse_arguments(arguments: &str) -> Result<Value, String> {
    let value = serde_json::from_str::<Value>(arguments)
        .map_err(|_| "A stored tool call contains invalid JSON arguments.".to_string())?;
    if value.is_object() {
        Ok(value)
    } else {
        Err("Tool call arguments must be a JSON object.".to_string())
    }
}

fn convert_tools(tools: Option<&Value>) -> Option<Vec<Value>> {
    Some(tools?.as_array()?.iter().filter_map(|tool| {
        let function = tool.get("function")?;
        Some(json!({
            "name": function.get("name")?.as_str()?,
            "description": function.get("description").and_then(Value::as_str).unwrap_or(""),
            "parameters": function.get("parameters").cloned().unwrap_or_else(|| json!({"type":"object"})),
        }))
    }).collect())
}

fn copy_number(
    source: &Value,
    target: &mut Map<String, Value>,
    source_key: &str,
    target_key: &str,
) {
    if source.get(source_key).is_some_and(Value::is_number) {
        target.insert(target_key.to_string(), source[source_key].clone());
    }
}

#[derive(Default)]
struct GoogleToolCallMetadata {
    native_id: Option<String>,
    signature: Option<String>,
}

fn encode_tool_call_id(index: usize, signature: Option<&str>, native_id: Option<&str>) -> String {
    let metadata = json!({
        "id": native_id.filter(|value| !value.is_empty()),
        "signature": signature.filter(|value| !value.is_empty()),
    });
    let encoded =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&metadata).unwrap_or_else(|_| b"{}".to_vec()));
    format!("{TOOL_CALL_ID_PREFIX}:{index}:{encoded}")
}

fn decode_tool_call_metadata(id: &str) -> GoogleToolCallMetadata {
    let mut parts = id.splitn(3, ':');
    if parts.next() != Some(TOOL_CALL_ID_PREFIX) {
        return GoogleToolCallMetadata::default();
    }
    let _index = parts.next();
    let Some(encoded) = parts.next() else {
        return GoogleToolCallMetadata::default();
    };
    let Some(payload) = URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return GoogleToolCallMetadata::default();
    };
    GoogleToolCallMetadata {
        native_id: payload
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string),
        signature: payload
            .get("signature")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

fn normalize_completion(body: &str) -> Result<String, String> {
    let payload = serde_json::from_str::<Value>(body)
        .map_err(|_| "Google Gemini returned an invalid response.".to_string())?;
    if let Some(block_reason) = payload
        .pointer("/promptFeedback/blockReason")
        .and_then(Value::as_str)
    {
        return Err(format!(
            "Google Gemini blocked the prompt ({block_reason})."
        ));
    }
    let candidate = payload
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|values| values.first())
        .ok_or_else(|| "Google Gemini returned no response candidate.".to_string())?;
    let parts = candidate
        .pointer("/content/parts")
        .and_then(Value::as_array)
        .ok_or_else(|| "Google Gemini returned an invalid response.".to_string())?;
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_calls = Vec::new();

    for part in parts {
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            if part
                .get("thought")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                reasoning.push_str(text);
            } else {
                content.push_str(text);
            }
        }
        if let Some(call) = part.get("functionCall") {
            let name = call.get("name").and_then(Value::as_str).unwrap_or_default();
            if !name.is_empty() {
                let id = encode_tool_call_id(
                    tool_calls.len(),
                    part.get("thoughtSignature").and_then(Value::as_str),
                    call.get("id").and_then(Value::as_str),
                );
                tool_calls.push(json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": call.get("args").filter(|args| args.is_object())
                            .and_then(|args| serde_json::to_string(args).ok())
                            .unwrap_or_else(|| "{}".to_string()),
                    }
                }));
            }
        }
    }
    let mut message = json!({ "role": "assistant", "content": content });
    if !reasoning.is_empty() {
        message["reasoning_content"] = Value::String(reasoning);
    }
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls);
    }
    let finish = candidate
        .get("finishReason")
        .and_then(Value::as_str)
        .unwrap_or("STOP");
    let finish_reason = map_finish_reason(finish)?;
    serde_json::to_string(&json!({
        "model": payload.get("modelVersion").cloned().unwrap_or(Value::Null),
        "choices": [{ "index": 0, "message": message, "finish_reason": finish_reason }],
        "usage": payload.get("usageMetadata").cloned().unwrap_or(Value::Null),
    }))
    .map_err(|_| "Could not normalize the Google Gemini response.".to_string())
}

#[derive(Default)]
struct GoogleStreamState {
    finished: bool,
    next_tool_index: usize,
}

fn process_stream_event(
    data: &str,
    state: &mut GoogleStreamState,
    model: &ProviderResolvedModel,
) -> Result<Vec<(ProviderChatChunkKind, String, Option<usize>)>, String> {
    if data.trim().is_empty() || data.trim() == "[DONE]" {
        return Ok(Vec::new());
    }
    let payload = parse_json(data)?;
    if payload.get("error").is_some() {
        return Err(map_provider_error(None, data, None).message);
    }
    if let Some(block_reason) = payload
        .pointer("/promptFeedback/blockReason")
        .and_then(Value::as_str)
    {
        return Err(format!(
            "Google Gemini blocked the prompt ({block_reason})."
        ));
    }
    let Some(candidate) = payload
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|values| values.first())
    else {
        return Ok(Vec::new());
    };
    let mut chunks = Vec::new();
    for part in candidate
        .pointer("/content/parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(text) = part
            .get("text")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            let kind = if part
                .get("thought")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                ProviderChatChunkKind::Reasoning
            } else {
                ProviderChatChunkKind::Content
            };
            chunks.push((kind, text.to_string(), None));
        }
        if let Some(call) = part.get("functionCall") {
            let name = call.get("name").and_then(Value::as_str).unwrap_or_default();
            if !name.is_empty() {
                let index = state.next_tool_index;
                state.next_tool_index += 1;
                let id = encode_tool_call_id(
                    index,
                    part.get("thoughtSignature").and_then(Value::as_str),
                    call.get("id").and_then(Value::as_str),
                );
                chunks.push((ProviderChatChunkKind::ToolCallId, id, Some(index)));
                chunks.push((
                    ProviderChatChunkKind::ToolName,
                    name.to_string(),
                    Some(index),
                ));
                let arguments = call
                    .get("args")
                    .filter(|args| args.is_object())
                    .and_then(|args| serde_json::to_string(args).ok())
                    .unwrap_or_else(|| "{}".to_string());
                chunks.push((ProviderChatChunkKind::ToolArguments, arguments, Some(index)));
            }
        }
    }
    if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
        map_finish_reason(reason)?;
        state.finished = true;
    }
    chunks.extend(
        capture_replay_payloads(&payload, model.model.reasoning.as_ref())?
            .into_iter()
            .map(|chunk| (ProviderChatChunkKind::ReasoningReplay, chunk, None)),
    );
    Ok(chunks)
}

fn map_finish_reason(reason: &str) -> Result<&'static str, String> {
    match reason {
        "STOP" | "FINISH_REASON_UNSPECIFIED" => Ok("stop"),
        "MAX_TOKENS" => Ok("length"),
        "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" | "IMAGE_SAFETY" => {
            Err(format!("Google Gemini blocked the response ({reason})."))
        }
        "MALFORMED_FUNCTION_CALL" | "UNEXPECTED_TOOL_CALL" => Err(format!(
            "Google Gemini could not produce a valid tool call ({reason})."
        )),
        other => Err(format!(
            "Google Gemini ended the response unexpectedly ({other})."
        )),
    }
}

fn resolve_stream(state: GoogleStreamState, emitted_any: bool) -> Result<(), String> {
    if state.finished {
        Ok(())
    } else if !emitted_any {
        Err("Google Gemini stream closed without returning any content.".to_string())
    } else {
        Err("Google Gemini stream closed before the response finished.".to_string())
    }
}

pub async fn fetch_models(
    provider: &ProviderSecretRecord,
) -> Result<Vec<ProviderModelRecord>, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "Could not initialize the provider connection.".to_string())?;
    let mut models = Vec::new();
    let mut page_token: Option<String> = None;
    let mut seen = std::collections::HashSet::new();

    for _ in 0..100 {
        let request = client
            .get(endpoint_with_version(
                &provider.endpoint,
                "v1beta",
                "models",
            ))
            .query(&[("pageSize", "1000")]);
        let mut request =
            apply_provider_headers(request, provider).map_err(|error| error.message)?;
        if let Some(token) = page_token.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }
        let response = checked_response(request.send().await)
            .await
            .map_err(|error| error.message)?;
        let body = response_text(response)
            .await
            .map_err(|error| error.message)?;
        let payload = serde_json::from_str::<Value>(&body)
            .map_err(|_| "Google Gemini returned an invalid model list.".to_string())?;
        let entries = payload
            .get("models")
            .and_then(Value::as_array)
            .ok_or_else(|| "Google Gemini returned an invalid model list.".to_string())?;

        for entry in entries {
            let supports_generate = entry
                .get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .is_none_or(|methods| {
                    methods
                        .iter()
                        .any(|method| method.as_str() == Some("generateContent"))
                });
            if !supports_generate {
                continue;
            }
            let Some(id) = entry
                .get("name")
                .and_then(Value::as_str)
                .map(|name| name.trim_start_matches("models/").trim())
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            if seen.insert(id.to_string()) {
                models.push(ProviderModelRecord {
                    capabilities: Vec::new(),
                    display_name: entry
                        .get("displayName")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    max_context: entry.get("inputTokenLimit").and_then(Value::as_u64),
                    max_output_tokens: entry.get("outputTokenLimit").and_then(Value::as_u64),
                    model_id: id.to_string(),
                    reasoning: None,
                    reasoning_levels: Vec::new(),
                });
            }
        }
        page_token = payload
            .get("nextPageToken")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .map(str::to_string);
        if page_token.is_none() {
            break;
        }
    }
    if models.is_empty() {
        return Err("Google Gemini returned no usable models.".to_string());
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::{
        build_request_body, decode_tool_call_metadata, encode_tool_call_id, normalize_completion,
    };
    use crate::providers::reasoning::{ModelReasoningConfig, ProviderReasoningSelection};
    use crate::providers::types::{
        ProviderModelRecord, ProviderResolvedModel, ProviderSecretRecord,
    };
    use serde_json::json;

    fn model() -> ProviderResolvedModel {
        ProviderResolvedModel {
            model_uuid: "uuid".to_string(),
            model: ProviderModelRecord {
                capabilities: vec!["text".to_string()],
                display_name: None,
                max_context: None,
                max_output_tokens: Some(8192),
                model_id: "gemini-3-pro".to_string(),
                reasoning: Some(
                    serde_json::from_value::<ModelReasoningConfig>(json!({
                        "variants": [{
                            "id": "high",
                            "label": "High",
                            "request": [{
                                "operation": "set",
                                "path": "/generationConfig/thinkingConfig/thinkingLevel",
                                "value": "HIGH"
                            }]
                        }]
                    }))
                    .expect("reasoning recipe"),
                ),
                reasoning_levels: vec!["low".to_string(), "high".to_string()],
            },
            provider: ProviderSecretRecord {
                api_key: Some("key".to_string()),
                api_key_required: true,
                auth_header_name: Some("x-goog-api-key".to_string()),
                auth_header_prefix: String::new(),
                chat_completions_path: None,
                endpoint: "https://generativelanguage.googleapis.com".to_string(),
                headers: Vec::new(),
                id: "p".to_string(),
                models_path: None,
                name: "Google".to_string(),
                provider_type: "google".to_string(),
                request_fields: Vec::new(),
            },
        }
    }

    #[test]
    fn thought_signature_round_trips_through_tool_id() {
        let id = encode_tool_call_id(2, Some("opaque signature/+"), Some("native-call-2"));
        let metadata = decode_tool_call_metadata(&id);
        assert_eq!(metadata.signature.as_deref(), Some("opaque signature/+"));
        assert_eq!(metadata.native_id.as_deref(), Some("native-call-2"));
    }

    #[test]
    fn converts_messages_tools_and_signature() {
        let id = encode_tool_call_id(0, Some("signature"), Some("native-call-0"));
        let selection = ProviderReasoningSelection {
            variant_id: "high".to_string(),
            ..ProviderReasoningSelection::default()
        };
        let body = build_request_body(&model(), &json!({
            "messages":[
                {"role":"system","content":"Be concise"},
                {"role":"user","content":"hi"},
                {"role":"assistant","tool_calls":[{"id":id,"type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}}]},
                {"role":"tool","tool_call_id":id,"content":"{\"ok\":true}"}
            ],
            "tools":[{"type":"function","function":{"name":"read_file","description":"Read","parameters":{"type":"object"}}}]
        }), Some(&selection)).expect("request");

        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "Be concise");
        assert_eq!(
            body["contents"][1]["parts"][0]["thoughtSignature"],
            "signature"
        );
        assert_eq!(
            body["contents"][1]["parts"][0]["functionCall"]["id"],
            "native-call-0"
        );
        assert_eq!(
            body["contents"][2]["parts"][0]["functionResponse"]["name"],
            "read_file"
        );
        assert_eq!(
            body["contents"][2]["parts"][0]["functionResponse"]["id"],
            "native-call-0"
        );
        assert_eq!(
            body["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "HIGH"
        );
    }

    #[test]
    fn normalizes_google_tool_call() {
        let result = normalize_completion(&json!({
            "candidates":[{"content":{"parts":[{"functionCall":{"id":"native-1","name":"read_file","args":{"path":"a"}},"thoughtSignature":"sig"}]},"finishReason":"STOP"}]
        }).to_string()).expect("completion");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("json");
        let id = parsed["choices"][0]["message"]["tool_calls"][0]["id"]
            .as_str()
            .expect("id");
        let metadata = decode_tool_call_metadata(id);
        assert_eq!(metadata.signature.as_deref(), Some("sig"));
        assert_eq!(metadata.native_id.as_deref(), Some("native-1"));
    }
}
