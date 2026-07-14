use futures_util::StreamExt;
use reqwest::header::CONTENT_TYPE;
use serde_json::{json, Map, Value};
use tauri::Window;

use super::native_transport::{
    checked_response, emit_chunks, endpoint_with_version, is_transient, parse_json, response_text,
    wait_before_retry, SseDecoder, MAX_RETRY_ATTEMPTS, STREAM_IDLE_TIMEOUT,
};
use super::openai_compatible::{map_provider_error, ProviderChatChunkKind, ProviderRequestError};
use super::types::{ProviderModelRecord, ProviderResolvedModel, ProviderSecretRecord};

const API_VERSION: &str = "2023-06-01";
const DEFAULT_MAX_TOKENS: u64 = 8_192;

pub async fn complete_chat(
    client: &reqwest::Client,
    model: &ProviderResolvedModel,
    body: Value,
    reasoning_level: Option<&str>,
) -> Result<String, String> {
    let request_body = build_request_body(model, &body, false, reasoning_level)?;
    let mut attempt = 0;

    loop {
        match post_messages(client, model, &request_body).await {
            Ok(response) => {
                let body = response_text(response).await?;
                return normalize_completion(&body);
            }
            Err(error) if error.retryable && attempt < MAX_RETRY_ATTEMPTS => {
                attempt += 1;
                wait_before_retry(attempt).await;
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
    reasoning_level: Option<&str>,
) -> Result<(), String> {
    let request_body = build_request_body(model, &body, true, reasoning_level)?;
    let mut attempt = 0;
    let mut emitted_any = false;

    'retry: loop {
        let response = match post_messages(client, model, &request_body).await {
            Ok(response) => response,
            Err(error) if error.retryable && attempt < MAX_RETRY_ATTEMPTS && !emitted_any => {
                attempt += 1;
                wait_before_retry(attempt).await;
                continue;
            }
            Err(error) => return Err(error.message),
        };

        let mut stream = response.bytes_stream();
        let mut decoder = SseDecoder::default();
        let mut state = AnthropicStreamState::default();

        loop {
            let item = tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next())
                .await
                .map_err(|_| "Provider stream timed out while waiting for data.".to_string())?;
            let Some(item) = item else { break };
            let bytes = match item {
                Ok(bytes) => bytes,
                Err(error)
                    if is_transient(&error) && attempt < MAX_RETRY_ATTEMPTS && !emitted_any =>
                {
                    attempt += 1;
                    wait_before_retry(attempt).await;
                    continue 'retry;
                }
                Err(error) => return Err(map_provider_error(None, "", Some(&error)).message),
            };

            for event in decoder.append(&bytes)? {
                let chunks = process_stream_event(&event.data, &mut state)?;
                emitted_any |= emit_chunks(&window, request_id, chunks)? > 0;
            }
        }

        for event in decoder.finish()? {
            let chunks = process_stream_event(&event.data, &mut state)?;
            emitted_any |= emit_chunks(&window, request_id, chunks)? > 0;
        }

        return resolve_stream(state, emitted_any);
    }
}

async fn post_messages(
    client: &reqwest::Client,
    model: &ProviderResolvedModel,
    body: &Value,
) -> Result<reqwest::Response, ProviderRequestError> {
    let api_key = model
        .provider
        .api_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| {
            ProviderRequestError::new(
                "Anthropic requires an API key for direct requests.".to_string(),
                false,
            )
        })?;
    let request = client
        .post(endpoint_with_version(
            &model.provider.endpoint,
            "v1",
            "messages",
        ))
        .header(CONTENT_TYPE, "application/json")
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .json(body)
        .send()
        .await;

    checked_response(request).await
}

fn build_request_body(
    model: &ProviderResolvedModel,
    body: &Value,
    stream: bool,
    reasoning_level: Option<&str>,
) -> Result<Value, String> {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Provider request is missing messages.".to_string())?;
    let mut system_blocks = Vec::new();
    let mut converted = Vec::new();
    let mut tool_names = std::collections::HashMap::new();

    for message in messages {
        match message.get("role").and_then(Value::as_str) {
            Some("system") => system_blocks.extend(text_blocks(message.get("content"))),
            Some("user") => push_message(
                &mut converted,
                "user",
                anthropic_content_blocks(message.get("content"))?,
            ),
            Some("assistant") => {
                let mut blocks = anthropic_content_blocks(message.get("content"))?;
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
                        let input = parse_arguments(
                            function
                                .and_then(|value| value.get("arguments"))
                                .and_then(Value::as_str)
                                .unwrap_or("{}"),
                        )?;
                        tool_names.insert(id.to_string(), name.to_string());
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": input,
                        }));
                    }
                }
                push_message(&mut converted, "assistant", blocks);
            }
            Some("tool") => {
                let tool_use_id = message
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if tool_use_id.is_empty() {
                    return Err("A stored tool result is missing its tool call id.".to_string());
                }
                let _ = tool_names.get(tool_use_id);
                let content = message
                    .get("content")
                    .map(content_as_text)
                    .unwrap_or_default();
                push_message(
                    &mut converted,
                    "user",
                    vec![json!({
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": content,
                    })],
                );
            }
            Some(_) | None => {}
        }
    }

    if converted.is_empty() {
        return Err("Provider request contains no usable messages.".to_string());
    }

    let max_tokens = body
        .get("max_tokens")
        .and_then(Value::as_u64)
        .or(model.model.max_output_tokens)
        .unwrap_or(DEFAULT_MAX_TOKENS)
        .max(1);
    let mut output = json!({
        "model": model.model.model_id,
        "messages": converted,
        "max_tokens": max_tokens,
        "stream": stream,
    });
    let object = output.as_object_mut().expect("request body object");

    if !system_blocks.is_empty() {
        object.insert("system".to_string(), Value::Array(system_blocks));
    }
    copy_number(body, object, "temperature");
    copy_number(body, object, "top_p");

    let tool_choice = body.get("tool_choice").and_then(Value::as_str);
    if tool_choice != Some("none") {
        if let Some(tools) = convert_tools(body.get("tools")) {
            if !tools.is_empty() {
                object.insert("tools".to_string(), Value::Array(tools));
                object.insert("tool_choice".to_string(), json!({ "type": "auto" }));
            }
        }
    }

    if !model.model.reasoning_levels.is_empty() {
        if let Some(effort) = reasoning_level.and_then(anthropic_effort) {
            object.insert("output_config".to_string(), json!({ "effort": effort }));
        }
    }

    Ok(output)
}

fn anthropic_content_blocks(content: Option<&Value>) -> Result<Vec<Value>, String> {
    let Some(content) = content else {
        return Ok(Vec::new());
    };
    if let Some(text) = content.as_str() {
        return Ok(if text.is_empty() {
            Vec::new()
        } else {
            vec![json!({ "type": "text", "text": text })]
        });
    }

    let mut blocks = Vec::new();
    for part in content.as_array().into_iter().flatten() {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        blocks.push(json!({ "type": "text", "text": text }));
                    }
                }
            }
            Some("image_url") => {
                let url = part
                    .pointer("/image_url/url")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "An image attachment is missing its URL.".to_string())?;
                blocks.push(anthropic_image_block(url)?);
            }
            _ => {}
        }
    }
    Ok(blocks)
}

fn anthropic_image_block(url: &str) -> Result<Value, String> {
    if let Some((media_type, data)) = parse_data_url(url) {
        return Ok(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": media_type, "data": data },
        }));
    }
    if url.starts_with("https://") {
        return Ok(json!({
            "type": "image",
            "source": { "type": "url", "url": url },
        }));
    }
    Err("Anthropic image attachments must be HTTPS or base64 data URLs.".to_string())
}

fn parse_data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (metadata, data) = rest.split_once(',')?;
    let media_type = metadata.strip_suffix(";base64")?;
    if media_type.is_empty() || data.is_empty() {
        return None;
    }
    Some((media_type, data))
}

fn text_blocks(content: Option<&Value>) -> Vec<Value> {
    let text = content.map(content_as_text).unwrap_or_default();
    if text.is_empty() {
        Vec::new()
    } else {
        vec![json!({ "type": "text", "text": text })]
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

fn push_message(messages: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if blocks.is_empty() {
        return;
    }
    if let Some(previous) = messages.last_mut() {
        if previous.get("role").and_then(Value::as_str) == Some(role) {
            if let Some(content) = previous.get_mut("content").and_then(Value::as_array_mut) {
                content.extend(blocks);
                return;
            }
        }
    }
    messages.push(json!({ "role": role, "content": blocks }));
}

fn parse_arguments(arguments: &str) -> Result<Value, String> {
    let value = serde_json::from_str::<Value>(arguments)
        .map_err(|_| "A stored tool call contains invalid JSON arguments.".to_string())?;
    if !value.is_object() {
        return Err("Tool call arguments must be a JSON object.".to_string());
    }
    Ok(value)
}

fn convert_tools(tools: Option<&Value>) -> Option<Vec<Value>> {
    let tools = tools?.as_array()?;
    Some(
        tools
            .iter()
            .filter_map(|tool| {
                let function = tool.get("function")?;
                let name = function.get("name")?.as_str()?;
                Some(json!({
                    "name": name,
                    "description": function.get("description").and_then(Value::as_str).unwrap_or(""),
                    "input_schema": function.get("parameters").cloned().unwrap_or_else(|| json!({"type":"object"})),
                }))
            })
            .collect(),
    )
}

fn copy_number(source: &Value, target: &mut Map<String, Value>, key: &str) {
    if source.get(key).is_some_and(Value::is_number) {
        target.insert(key.to_string(), source[key].clone());
    }
}

fn anthropic_effort(level: &str) -> Option<&'static str> {
    match level.trim().to_ascii_lowercase().as_str() {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" | "max" => Some("max"),
        _ => None,
    }
}

fn normalize_completion(body: &str) -> Result<String, String> {
    let payload = serde_json::from_str::<Value>(body)
        .map_err(|_| "Anthropic returned an invalid response.".to_string())?;
    let blocks = payload
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| "Anthropic returned an invalid response.".to_string())?;
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_calls = Vec::new();

    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                content.push_str(block.get("text").and_then(Value::as_str).unwrap_or(""))
            }
            Some("thinking") => {
                reasoning.push_str(block.get("thinking").and_then(Value::as_str).unwrap_or(""))
            }
            Some("tool_use") => {
                let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !id.is_empty() && !name.is_empty() {
                    tool_calls.push(json!({
                        "id": id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": serde_json::to_string(block.get("input").unwrap_or(&json!({}))).unwrap_or_else(|_| "{}".to_string()),
                        }
                    }));
                }
            }
            _ => {}
        }
    }

    let mut message = json!({ "role": "assistant", "content": content });
    if !reasoning.is_empty() {
        message["reasoning_content"] = Value::String(reasoning);
    }
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls);
    }
    let finish_reason = map_stop_reason(
        payload
            .get("stop_reason")
            .and_then(Value::as_str)
            .unwrap_or("end_turn"),
    );
    serde_json::to_string(&json!({
        "id": payload.get("id").cloned().unwrap_or(Value::Null),
        "model": payload.get("model").cloned().unwrap_or(Value::Null),
        "choices": [{ "index": 0, "message": message, "finish_reason": finish_reason }],
        "usage": payload.get("usage").cloned().unwrap_or(Value::Null),
    }))
    .map_err(|_| "Could not normalize the Anthropic response.".to_string())
}

#[derive(Default)]
struct AnthropicStreamState {
    finished: bool,
    next_tool_index: usize,
    stop_reason: Option<String>,
    tool_indexes_by_block: std::collections::HashMap<usize, usize>,
}

fn process_stream_event(
    data: &str,
    state: &mut AnthropicStreamState,
) -> Result<Vec<(ProviderChatChunkKind, String, Option<usize>)>, String> {
    if data.trim().is_empty() {
        return Ok(Vec::new());
    }
    let payload = parse_json(data)?;
    let event_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let block_index = payload
        .get("index")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    let mut chunks = Vec::new();

    match event_type {
        "content_block_start" => {
            let block = payload.get("content_block").unwrap_or(&Value::Null);
            match block.get("type").and_then(Value::as_str) {
                Some("text") => push_if_present(
                    &mut chunks,
                    ProviderChatChunkKind::Content,
                    block.get("text"),
                    None,
                ),
                Some("thinking") => push_if_present(
                    &mut chunks,
                    ProviderChatChunkKind::Reasoning,
                    block.get("thinking"),
                    None,
                ),
                Some("tool_use") => {
                    let block_index = block_index.ok_or_else(|| {
                        "Anthropic tool stream is missing its content block index.".to_string()
                    })?;
                    let tool_index = state.next_tool_index;
                    state.next_tool_index += 1;
                    state.tool_indexes_by_block.insert(block_index, tool_index);
                    push_if_present(
                        &mut chunks,
                        ProviderChatChunkKind::ToolCallId,
                        block.get("id"),
                        Some(tool_index),
                    );
                    push_if_present(
                        &mut chunks,
                        ProviderChatChunkKind::ToolName,
                        block.get("name"),
                        Some(tool_index),
                    );
                    if let Some(input) = block
                        .get("input")
                        .filter(|value| value.as_object().is_some_and(|object| !object.is_empty()))
                    {
                        chunks.push((
                            ProviderChatChunkKind::ToolArguments,
                            serde_json::to_string(input).unwrap_or_else(|_| "{}".to_string()),
                            Some(tool_index),
                        ));
                    }
                }
                _ => {}
            }
        }
        "content_block_delta" => {
            let delta = payload.get("delta").unwrap_or(&Value::Null);
            match delta.get("type").and_then(Value::as_str) {
                Some("text_delta") => push_if_present(
                    &mut chunks,
                    ProviderChatChunkKind::Content,
                    delta.get("text"),
                    None,
                ),
                Some("thinking_delta") => push_if_present(
                    &mut chunks,
                    ProviderChatChunkKind::Reasoning,
                    delta.get("thinking"),
                    None,
                ),
                Some("input_json_delta") => {
                    let tool_index = block_index
                        .and_then(|index| state.tool_indexes_by_block.get(&index).copied())
                        .ok_or_else(|| {
                            "Anthropic tool stream referenced an unknown content block.".to_string()
                        })?;
                    push_if_present(
                        &mut chunks,
                        ProviderChatChunkKind::ToolArguments,
                        delta.get("partial_json"),
                        Some(tool_index),
                    );
                }
                _ => {}
            }
        }
        "message_delta" => {
            state.stop_reason = payload
                .pointer("/delta/stop_reason")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        "message_stop" => state.finished = true,
        "error" => return Err(map_provider_error(None, data, None).message),
        _ => {}
    }
    Ok(chunks)
}

fn push_if_present(
    chunks: &mut Vec<(ProviderChatChunkKind, String, Option<usize>)>,
    kind: ProviderChatChunkKind,
    value: Option<&Value>,
    index: Option<usize>,
) {
    if let Some(text) = value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        chunks.push((kind, text.to_string(), index));
    }
}

fn map_stop_reason(reason: &str) -> &'static str {
    match reason {
        "tool_use" => "tool_calls",
        "max_tokens" | "model_context_window_exceeded" => "length",
        "refusal" => "content_filter",
        _ => "stop",
    }
}

fn resolve_stream(state: AnthropicStreamState, emitted_any: bool) -> Result<(), String> {
    if state.finished {
        return match state.stop_reason.as_deref().map(map_stop_reason) {
            Some("content_filter") => Err("Anthropic blocked the response.".to_string()),
            _ => Ok(()),
        };
    }
    if !emitted_any {
        Err("Anthropic stream closed without returning any content.".to_string())
    } else {
        Err("Anthropic stream closed before the response finished.".to_string())
    }
}

pub async fn fetch_models(
    provider: &ProviderSecretRecord,
) -> Result<Vec<ProviderModelRecord>, String> {
    let api_key = provider
        .api_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| "Anthropic requires an API key to refresh models.".to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "Could not initialize the provider connection.".to_string())?;
    let mut models = Vec::new();
    let mut after_id: Option<String> = None;
    let mut seen = std::collections::HashSet::new();

    for _ in 0..100 {
        let mut request = client
            .get(endpoint_with_version(&provider.endpoint, "v1", "models"))
            .header("x-api-key", api_key)
            .header("anthropic-version", API_VERSION)
            .query(&[("limit", "1000")]);
        if let Some(cursor) = after_id.as_deref() {
            request = request.query(&[("after_id", cursor)]);
        }
        let response = checked_response(request.send().await)
            .await
            .map_err(|error| error.message)?;
        let body = response_text(response).await?;
        let payload = serde_json::from_str::<Value>(&body)
            .map_err(|_| "Anthropic returned an invalid model list.".to_string())?;
        let data = payload
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| "Anthropic returned an invalid model list.".to_string())?;

        for entry in data {
            let Some(id) = entry
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            if seen.insert(id.to_string()) {
                models.push(ProviderModelRecord {
                    capabilities: Vec::new(),
                    display_name: entry
                        .get("display_name")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    max_context: None,
                    max_output_tokens: None,
                    model_id: id.to_string(),
                    reasoning_levels: Vec::new(),
                    tokenizer_json: None,
                    tokenizer_kind: None,
                });
            }
        }

        if !payload
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            break;
        }
        after_id = payload
            .get("last_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        if after_id.is_none() {
            return Err("Anthropic model pagination returned no cursor.".to_string());
        }
    }

    if models.is_empty() {
        return Err("Anthropic returned no usable models.".to_string());
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::{
        build_request_body, normalize_completion, process_stream_event, AnthropicStreamState,
    };
    use crate::providers::openai_compatible::ProviderChatChunkKind;
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
                max_output_tokens: Some(4096),
                model_id: "claude-test".to_string(),
                reasoning_levels: vec!["low".to_string(), "high".to_string()],
                tokenizer_json: None,
                tokenizer_kind: None,
            },
            provider: ProviderSecretRecord {
                api_key: Some("key".to_string()),
                endpoint: "https://api.anthropic.com".to_string(),
                id: "p".to_string(),
                name: "Anthropic".to_string(),
                provider_type: "anthropic".to_string(),
            },
        }
    }

    #[test]
    fn converts_openai_messages_and_tools() {
        let body = build_request_body(&model(), &json!({
            "messages": [
                {"role":"system","content":"Be concise"},
                {"role":"user","content":"hi"},
                {"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a\"}"}}]},
                {"role":"tool","tool_call_id":"call-1","content":"ok"}
            ],
            "tools":[{"type":"function","function":{"name":"read_file","description":"Read","parameters":{"type":"object"}}}],
            "tool_choice":"auto"
        }), true, Some("high")).expect("request");

        assert_eq!(body["model"], "claude-test");
        assert_eq!(body["system"][0]["text"], "Be concise");
        assert_eq!(body["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(body["output_config"]["effort"], "high");
    }

    #[test]
    fn normalizes_tool_completion() {
        let result = normalize_completion(&json!({"id":"msg","model":"claude-test","content":[{"type":"tool_use","id":"call-1","name":"read_file","input":{"path":"a"}}],"stop_reason":"tool_use"}).to_string()).expect("completion");
        let parsed: serde_json::Value = serde_json::from_str(&result).expect("json");
        assert_eq!(parsed["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(
            parsed["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
            "read_file"
        );
    }

    #[test]
    fn parses_streamed_tool_arguments() {
        let mut state = AnthropicStreamState::default();
        process_stream_event(
            r#"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call-1","name":"read_file","input":{}}}"#,
            &mut state,
        )
        .expect("tool start");
        let chunks = process_stream_event(r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#, &mut state).expect("event");
        assert_eq!(chunks.len(), 1);
        assert!(matches!(chunks[0].0, ProviderChatChunkKind::ToolArguments));
        assert_eq!(chunks[0].2, Some(0));
    }
}
