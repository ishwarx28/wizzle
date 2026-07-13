use futures_util::StreamExt;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{Emitter, Window};

use crate::logging::log_desktop_event;

use super::types::{ProviderModelRecord, ProviderResolvedModel, ProviderSecretRecord};

const MAX_SSE_BUFFER_BYTES: usize = 10 * 1024 * 1024;
const MAX_PROVIDER_RETRY_ATTEMPTS: usize = 2;
const PROVIDER_RETRY_DELAYS_MS: [u64; MAX_PROVIDER_RETRY_ATTEMPTS] = [250, 1000];
const OPENAI_API_PREFIX: &str = "/v1";
const OPENAI_CHAT_COMPLETIONS_PATH: &str = "/chat/completions";
const OPENAI_MODELS_PATH: &str = "/models";
const PROVIDER_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PROVIDER_COMPLETION_TIMEOUT: Duration = Duration::from_secs(300);
const PROVIDER_STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const PROVIDER_CATALOG_TIMEOUT: Duration = Duration::from_secs(30);
const PROVIDER_CATALOG_MAX_BYTES: usize = 10 * 1024 * 1024;
pub const PROVIDER_CHAT_CHUNK_EVENT: &str = "provider-chat-chunk";

pub fn completion_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(PROVIDER_CONNECT_TIMEOUT)
        .timeout(PROVIDER_COMPLETION_TIMEOUT)
        .build()
        .map_err(|_| "Could not initialize the provider connection.".to_string())
}

pub fn stream_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(PROVIDER_CONNECT_TIMEOUT)
        .build()
        .map_err(|_| "Could not initialize the provider connection.".to_string())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderChatChunkPayload {
    pub chunk: String,
    pub kind: ProviderChatChunkKind,
    pub request_id: String,
    pub tool_call_index: Option<usize>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderChatChunkKind {
    Content,
    Reasoning,
    ToolArguments,
    ToolCallId,
    ToolName,
}

pub struct ProviderRequestError {
    pub message: String,
    pub retryable: bool,
}

impl ProviderRequestError {
    fn new(message: String, retryable: bool) -> Self {
        Self { message, retryable }
    }
}

fn extract_text_value(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }

    let Some(parts) = value.as_array() else {
        return String::new();
    };

    parts
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<String>()
}

fn extract_delta_chunks(payload: &Value) -> Vec<(ProviderChatChunkKind, String, Option<usize>)> {
    let Some(choices) = payload.get("choices").and_then(Value::as_array) else {
        return Vec::new();
    };

    let Some(delta) = choices
        .first()
        .and_then(|choice| choice.get("delta"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };

    let mut chunks = Vec::new();

    for (key, kind) in [
        ("reasoning_content", ProviderChatChunkKind::Reasoning),
        ("reasoning", ProviderChatChunkKind::Reasoning),
        ("content", ProviderChatChunkKind::Content),
    ] {
        let Some(value) = delta.get(key) else {
            continue;
        };

        let text = extract_text_value(value);

        if !text.is_empty() {
            chunks.push((kind.clone(), text, None));
        }
    }

    if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
        for (fallback_index, tool_call) in tool_calls.iter().enumerate() {
            let Some(tool_call_object) = tool_call.as_object() else {
                continue;
            };
            let index = tool_call_object
                .get("index")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(fallback_index);

            if let Some(id) = tool_call_object.get("id").and_then(Value::as_str) {
                if !id.is_empty() {
                    chunks.push((
                        ProviderChatChunkKind::ToolCallId,
                        id.to_string(),
                        Some(index),
                    ));
                }
            }

            let Some(function_object) = tool_call_object.get("function").and_then(Value::as_object)
            else {
                continue;
            };

            if let Some(name) = function_object.get("name").and_then(Value::as_str) {
                if !name.is_empty() {
                    chunks.push((
                        ProviderChatChunkKind::ToolName,
                        name.to_string(),
                        Some(index),
                    ));
                }
            }

            if let Some(arguments) = function_object.get("arguments") {
                let text = extract_text_value(arguments);

                if !text.is_empty() {
                    chunks.push((ProviderChatChunkKind::ToolArguments, text, Some(index)));
                }
            }
        }
    }

    chunks
}

fn extract_error_fields(body: &str) -> (Option<String>, Option<String>) {
    let Ok(payload) = serde_json::from_str::<Value>(body) else {
        return (None, None);
    };
    let Some(error) = payload.get("error").and_then(Value::as_object) else {
        return (None, None);
    };

    (
        error
            .get("code")
            .and_then(Value::as_str)
            .map(str::to_string),
        error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string),
    )
}

pub fn map_provider_error(
    status_code: Option<u16>,
    body: &str,
    transport_error: Option<&reqwest::Error>,
) -> ProviderRequestError {
    if let Some(error) = transport_error {
        let message = if error.is_timeout() {
            "Provider request timed out.".to_string()
        } else if error.is_connect() || error.is_request() {
            "Provider is unreachable.".to_string()
        } else if error.is_body() {
            "Provider response was interrupted.".to_string()
        } else {
            "Provider request failed.".to_string()
        };

        return ProviderRequestError::new(message, true);
    }

    let (code, message) = extract_error_fields(body);
    let code_text = code.unwrap_or_default().to_ascii_lowercase();
    let message_text = message.as_deref().unwrap_or_default().to_ascii_lowercase();

    if code_text.contains("model_not_found")
        || message_text.contains("model") && message_text.contains("not found")
    {
        return ProviderRequestError::new("Selected model is unavailable.".to_string(), false);
    }

    if code_text.contains("context")
        || message_text.contains("context") && message_text.contains("length")
    {
        return ProviderRequestError::new(
            "Prompt is too long for the selected model.".to_string(),
            false,
        );
    }

    match status_code.unwrap_or_default() {
        401 | 403 => ProviderRequestError::new(
            "Provider authentication failed. Check the configured API key.".to_string(),
            false,
        ),
        408 => ProviderRequestError::new("Provider request timed out.".to_string(), true),
        429 => ProviderRequestError::new(
            "Provider rate limit reached. Try again shortly.".to_string(),
            true,
        ),
        500..=599 => {
            ProviderRequestError::new("Provider is temporarily unavailable.".to_string(), true)
        }
        _ => ProviderRequestError::new(
            message
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Provider could not complete the request.".to_string()),
            false,
        ),
    }
}

fn is_transient_reqwest_error(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request() || error.is_body()
}

async fn wait_before_retry(attempt: usize) {
    if attempt == 0 || attempt > MAX_PROVIDER_RETRY_ATTEMPTS {
        return;
    }

    tokio::time::sleep(Duration::from_millis(PROVIDER_RETRY_DELAYS_MS[attempt - 1])).await;
}

fn endpoint_with_path(endpoint: &str, path: &str) -> String {
    let endpoint = endpoint.trim_end_matches('/');
    let mut path = path.trim_start_matches('/');
    if endpoint.to_ascii_lowercase().ends_with("/v1") {
        path = path.strip_prefix("v1/").unwrap_or(path);
    }

    format!("{}/{}", endpoint, path)
}

fn discovered_model(model_id: &str) -> ProviderModelRecord {
    ProviderModelRecord {
        capabilities: Vec::new(),
        display_name: None,
        max_context: None,
        max_output_tokens: None,
        model_id: model_id.to_string(),
        reasoning_levels: Vec::new(),
        tokenizer_json: None,
        tokenizer_kind: None,
    }
}

/// Normalize reasoning level labels into OpenAI-compatible `reasoning_effort` values.
/// Accepted levels: low, medium, high, xhigh, max (and case/whitespace variants).
pub fn resolve_reasoning_effort(level: &str) -> Option<String> {
    let normalized = level.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "low" | "medium" | "high" | "xhigh" | "max" => Some(normalized),
        _ => None,
    }
}

fn model_supports_reasoning(model: &ProviderResolvedModel) -> bool {
    !model.model.reasoning_levels.is_empty()
}

pub(crate) fn build_request_body(
    model: &ProviderResolvedModel,
    mut body: Value,
    stream: bool,
    reasoning_level: Option<&str>,
) -> Value {
    if let Some(object) = body.as_object_mut() {
        object.insert(
            "model".to_string(),
            Value::String(model.model.model_id.clone()),
        );
        object.insert("stream".to_string(), Value::Bool(stream));

        if model_supports_reasoning(model) {
            if let Some(effort) = reasoning_level.and_then(resolve_reasoning_effort) {
                // Prefer the desktop UI selection over any stale body field.
                object.insert("reasoning_effort".to_string(), Value::String(effort));
            }
        }
    }

    body
}

async fn post_chat_completion(
    client: &reqwest::Client,
    resolved_model: &ProviderResolvedModel,
    body: Value,
    stream: bool,
    reasoning_level: Option<&str>,
) -> Result<reqwest::Response, ProviderRequestError> {
    if !matches!(
        resolved_model.provider.provider_type.as_str(),
        "openai" | "openai_compatible" | "custom_openai_compatible"
    ) {
        return Err(ProviderRequestError::new(
            "Direct calls are not available for this provider type yet.".to_string(),
            false,
        ));
    }

    let mut request = client
        .post(endpoint_with_path(
            &resolved_model.provider.endpoint,
            &format!("{OPENAI_API_PREFIX}{OPENAI_CHAT_COMPLETIONS_PATH}"),
        ))
        .header(CONTENT_TYPE, "application/json")
        .json(&build_request_body(
            resolved_model,
            body,
            stream,
            reasoning_level,
        ));

    if let Some(api_key) = resolved_model.provider.api_key.as_deref() {
        request = request.header(AUTHORIZATION, format!("Bearer {api_key}"));
    }

    let response = request
        .send()
        .await
        .map_err(|error| map_provider_error(None, "", Some(&error)))?;

    if !response.status().is_success() {
        let status_code = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(map_provider_error(Some(status_code), &body, None));
    }

    Ok(response)
}

#[derive(Clone, Debug, Default)]
struct SseProcessResult {
    emitted_chunk_count: usize,
    error_message: Option<String>,
    finish_reason: Option<String>,
    saw_done: bool,
}

fn extract_finish_reason(payload: &Value) -> Option<String> {
    payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extract_stream_error_message(payload: &Value) -> Option<String> {
    let error = payload.get("error")?;
    if let Some(message) = error.get("message").and_then(Value::as_str) {
        let trimmed = message.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Some(message) = error.as_str() {
        let trimmed = message.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    Some("Provider stream returned an error.".to_string())
}

/// Decide whether a finished SSE stream is a successful terminal close (#18).
fn resolve_stream_completion(
    saw_done: bool,
    finish_reason: Option<&str>,
    emitted_any_chunks: bool,
) -> Result<(), String> {
    if let Some(reason) = finish_reason {
        match reason {
            "stop" | "tool_calls" | "function_call" | "end_turn" | "length" => Ok(()),
            "content_filter" => {
                Err("The provider blocked the response (content filter).".to_string())
            }
            other => {
                if saw_done {
                    Ok(())
                } else {
                    Err(format!(
                        "Provider stream ended abnormally (finish_reason={other})."
                    ))
                }
            }
        }
    } else if saw_done {
        // Some proxies only emit [DONE] without finish_reason.
        Ok(())
    } else if !emitted_any_chunks {
        Err("Provider stream closed without returning any content.".to_string())
    } else {
        Err(
            "Provider stream closed before the response finished. The reply may be incomplete."
                .to_string(),
        )
    }
}

fn append_utf8_stream_chunk(
    buffer: &mut String,
    pending_utf8: &mut Vec<u8>,
    bytes: &[u8],
) -> Result<(), String> {
    pending_utf8.extend_from_slice(bytes);

    loop {
        match std::str::from_utf8(pending_utf8) {
            Ok(text) => {
                buffer.push_str(text);
                pending_utf8.clear();
                return Ok(());
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();

                if valid_up_to > 0 {
                    let valid_text = std::str::from_utf8(&pending_utf8[..valid_up_to])
                        .map_err(|_| "Provider stream returned invalid UTF-8.".to_string())?;
                    buffer.push_str(valid_text);
                    pending_utf8.drain(..valid_up_to);
                    continue;
                }

                if error.error_len().is_some() {
                    return Err("Provider stream returned invalid UTF-8.".to_string());
                }

                return Ok(());
            }
        }
    }
}

fn process_sse_events(
    request_id: &str,
    window: &Window,
    buffer: &mut String,
    keep_tail: bool,
) -> Result<SseProcessResult, String> {
    let normalized = buffer.replace("\r\n", "\n").replace('\r', "\n");
    let mut events = normalized.split("\n\n").collect::<Vec<_>>();

    *buffer = if keep_tail && !normalized.ends_with("\n\n") {
        events.pop().unwrap_or_default().to_string()
    } else {
        String::new()
    };

    let mut result = SseProcessResult::default();

    for event in events {
        let data_lines = event
            .split('\n')
            .map(str::trim)
            .filter_map(|line| line.strip_prefix("data:"))
            .map(|line| line.strip_prefix(' ').unwrap_or(line))
            .collect::<Vec<_>>();

        if data_lines.is_empty() {
            continue;
        }

        let data = data_lines.join("\n");
        let trimmed = data.trim();

        if trimmed.is_empty() {
            continue;
        }

        if trimmed == "[DONE]" {
            result.saw_done = true;
            continue;
        }

        let payload = serde_json::from_str::<Value>(&data)
            .map_err(|_| "Provider stream returned an invalid response.".to_string())?;

        if let Some(error_message) = extract_stream_error_message(&payload) {
            result.error_message = Some(error_message);
            continue;
        }

        if let Some(finish_reason) = extract_finish_reason(&payload) {
            result.finish_reason = Some(finish_reason);
        }

        for (kind, chunk, tool_call_index) in extract_delta_chunks(&payload) {
            window
                .emit(
                    PROVIDER_CHAT_CHUNK_EVENT,
                    ProviderChatChunkPayload {
                        chunk,
                        kind,
                        request_id: request_id.to_string(),
                        tool_call_index,
                    },
                )
                .map_err(|_| "Could not deliver the provider stream chunk.".to_string())?;
            result.emitted_chunk_count += 1;
        }
    }

    Ok(result)
}

pub async fn complete_chat(
    client: &reqwest::Client,
    resolved_model: &ProviderResolvedModel,
    body: Value,
    reasoning_level: Option<&str>,
) -> Result<String, String> {
    let mut attempt = 0;

    loop {
        match post_chat_completion(client, resolved_model, body.clone(), false, reasoning_level)
            .await
        {
            Ok(response) => {
                return response
                    .text()
                    .await
                    .map_err(|error| map_provider_error(None, "", Some(&error)).message);
            }
            Err(error) if error.retryable && attempt < MAX_PROVIDER_RETRY_ATTEMPTS => {
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
    resolved_model: &ProviderResolvedModel,
    body: Value,
    reasoning_level: Option<&str>,
) -> Result<(), String> {
    let mut attempt = 0;
    let mut emitted_any_chunks = false;

    'retry: loop {
        let response =
            match post_chat_completion(client, resolved_model, body.clone(), true, reasoning_level)
                .await
            {
                Ok(response) => response,
                Err(error)
                    if error.retryable
                        && attempt < MAX_PROVIDER_RETRY_ATTEMPTS
                        && !emitted_any_chunks =>
                {
                    attempt += 1;
                    wait_before_retry(attempt).await;
                    continue 'retry;
                }
                Err(error) => return Err(error.message),
            };

        let mut buffer = String::new();
        let mut pending_utf8 = Vec::new();
        let mut stream = response.bytes_stream();
        let mut saw_done = false;
        let mut finish_reason: Option<String> = None;

        loop {
            let item = tokio::time::timeout(PROVIDER_STREAM_IDLE_TIMEOUT, stream.next())
                .await
                .map_err(|_| "Provider stream timed out while waiting for data.".to_string())?;
            let Some(item) = item else {
                break;
            };
            let bytes = match item {
                Ok(bytes) => bytes,
                Err(error)
                    if is_transient_reqwest_error(&error)
                        && attempt < MAX_PROVIDER_RETRY_ATTEMPTS
                        && !emitted_any_chunks =>
                {
                    attempt += 1;
                    wait_before_retry(attempt).await;
                    continue 'retry;
                }
                Err(error) => return Err(map_provider_error(None, "", Some(&error)).message),
            };

            append_utf8_stream_chunk(&mut buffer, &mut pending_utf8, &bytes)?;

            if buffer.len().saturating_add(pending_utf8.len()) > MAX_SSE_BUFFER_BYTES {
                return Err("Provider stream exceeded the 10 MB safety limit.".to_string());
            }

            let parsed = process_sse_events(request_id, &window, &mut buffer, true)?;
            if let Some(error_message) = parsed.error_message {
                return Err(error_message);
            }
            emitted_any_chunks |= parsed.emitted_chunk_count > 0;
            saw_done |= parsed.saw_done;
            if parsed.finish_reason.is_some() {
                finish_reason = parsed.finish_reason;
            }
        }

        if !pending_utf8.is_empty() {
            return Err("Provider stream ended with incomplete UTF-8.".to_string());
        }

        if !buffer.trim().is_empty() {
            let parsed = process_sse_events(request_id, &window, &mut buffer, false)?;
            if let Some(error_message) = parsed.error_message {
                return Err(error_message);
            }
            emitted_any_chunks |= parsed.emitted_chunk_count > 0;
            saw_done |= parsed.saw_done;
            if parsed.finish_reason.is_some() {
                finish_reason = parsed.finish_reason;
            }
        }

        resolve_stream_completion(saw_done, finish_reason.as_deref(), emitted_any_chunks)?;
        return Ok(());
    }
}

pub async fn fetch_models(
    provider: &ProviderSecretRecord,
) -> Result<Vec<ProviderModelRecord>, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(PROVIDER_CONNECT_TIMEOUT)
        .timeout(PROVIDER_CATALOG_TIMEOUT)
        .build()
        .map_err(|_| "Could not initialize the provider connection.".to_string())?;
    let mut request = client.get(endpoint_with_path(
        &provider.endpoint,
        &format!("{OPENAI_API_PREFIX}{OPENAI_MODELS_PATH}"),
    ));

    if let Some(api_key) = provider.api_key.as_deref() {
        request = request.header(AUTHORIZATION, format!("Bearer {api_key}"));
    }

    let response = request
        .send()
        .await
        .map_err(|error| map_provider_error(None, "", Some(&error)).message)?;

    if !response.status().is_success() {
        let status_code = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(map_provider_error(Some(status_code), &body, None).message);
    }

    if response
        .content_length()
        .is_some_and(|length| length > PROVIDER_CATALOG_MAX_BYTES as u64)
    {
        return Err("Provider model list exceeded the 10 MB safety limit.".to_string());
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| map_provider_error(None, "", Some(&error)).message)?;
        if body.len().saturating_add(chunk.len()) > PROVIDER_CATALOG_MAX_BYTES {
            return Err("Provider model list exceeded the 10 MB safety limit.".to_string());
        }
        body.extend_from_slice(&chunk);
    }

    let payload = serde_json::from_slice::<Value>(&body)
        .map_err(|_| "Provider returned an invalid model list.".to_string())?;
    let data = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Provider returned an invalid model list.".to_string())?;

    let mut models = Vec::new();
    let mut seen_model_ids = std::collections::HashSet::new();

    for entry in data {
        let Some(model_id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };

        let model_id = model_id.trim();
        if model_id.is_empty() || !seen_model_ids.insert(model_id.to_string()) {
            continue;
        }

        models.push(discovered_model(model_id));
    }

    if models.is_empty() {
        return Err("Provider returned no usable models.".to_string());
    }

    log_desktop_event(
        "info",
        "desktop.provider",
        "models_refreshed",
        json!({
            "providerIdLength": provider.id.len(),
            "providerNameLength": provider.name.len(),
            "modelCount": models.len(),
        }),
    );

    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::{
        append_utf8_stream_chunk, build_request_body, discovered_model, endpoint_with_path,
        extract_finish_reason, map_provider_error, resolve_reasoning_effort,
        resolve_stream_completion,
    };
    use crate::providers::types::{
        ProviderModelRecord, ProviderResolvedModel, ProviderSecretRecord,
    };
    use serde_json::{json, Value};

    fn sample_model(reasoning_levels: Vec<String>) -> ProviderResolvedModel {
        ProviderResolvedModel {
            model: ProviderModelRecord {
                capabilities: vec!["text".to_string()],
                display_name: None,
                max_context: Some(128_000),
                max_output_tokens: None,
                model_id: "test-model".to_string(),
                reasoning_levels,
                tokenizer_json: None,
                tokenizer_kind: Some("heuristic".to_string()),
            },
            model_uuid: "uuid-1".to_string(),
            provider: ProviderSecretRecord {
                api_key: Some("key".to_string()),
                endpoint: "https://example.com".to_string(),
                id: "provider-1".to_string(),
                name: "Example".to_string(),
                provider_type: "openai_compatible".to_string(),
            },
        }
    }

    #[test]
    fn provider_endpoint_accepts_hosts_and_v1_api_bases() {
        assert_eq!(
            endpoint_with_path("https://api.example.test", "/v1/models"),
            "https://api.example.test/v1/models"
        );
        assert_eq!(
            endpoint_with_path("https://api.example.test/v1/", "/v1/models"),
            "https://api.example.test/v1/models"
        );
        assert_eq!(
            endpoint_with_path("https://api.example.test/api/v1", "/v1/chat/completions"),
            "https://api.example.test/api/v1/chat/completions"
        );
    }

    #[test]
    fn maps_authentication_errors() {
        let error = map_provider_error(Some(401), r#"{"error":{"message":"bad key"}}"#, None);

        assert_eq!(
            error.message,
            "Provider authentication failed. Check the configured API key."
        );
        assert!(!error.retryable);
    }

    #[test]
    fn catalog_model_keeps_unpublished_metadata_unknown() {
        let model = discovered_model("catalog-id");

        assert!(model.capabilities.is_empty());
        assert!(model.reasoning_levels.is_empty());
        assert_eq!(model.max_context, None);
        assert_eq!(model.max_output_tokens, None);
        assert_eq!(model.tokenizer_kind, None);
    }

    #[test]
    fn maps_context_overflow_errors() {
        let error = map_provider_error(
            Some(400),
            r#"{"error":{"message":"maximum context length exceeded"}}"#,
            None,
        );

        assert_eq!(error.message, "Prompt is too long for the selected model.");
        assert!(!error.retryable);
    }

    #[test]
    fn resolves_standard_reasoning_levels() {
        assert_eq!(resolve_reasoning_effort("low").as_deref(), Some("low"));
        assert_eq!(
            resolve_reasoning_effort("medium").as_deref(),
            Some("medium")
        );
        assert_eq!(resolve_reasoning_effort("high").as_deref(), Some("high"));
        assert_eq!(resolve_reasoning_effort("xhigh").as_deref(), Some("xhigh"));
        assert_eq!(resolve_reasoning_effort("max").as_deref(), Some("max"));
        assert_eq!(resolve_reasoning_effort("MAX").as_deref(), Some("max"));
        assert_eq!(resolve_reasoning_effort("fast").as_deref(), None);
        assert_eq!(resolve_reasoning_effort("balanced").as_deref(), None);
        assert_eq!(resolve_reasoning_effort("  ").as_deref(), None);
    }

    #[test]
    fn injects_reasoning_effort_when_model_supports_reasoning() {
        let model = sample_model(vec![
            "low".to_string(),
            "medium".to_string(),
            "high".to_string(),
            "max".to_string(),
        ]);
        let body = build_request_body(
            &model,
            json!({
                "messages": [],
                "model": "ignored",
            }),
            true,
            Some("medium"),
        );

        assert_eq!(
            body.get("reasoning_effort").and_then(Value::as_str),
            Some("medium")
        );
        assert_eq!(
            body.get("model").and_then(Value::as_str),
            Some("test-model")
        );
        assert_eq!(body.get("stream").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn skips_reasoning_effort_when_model_has_no_levels() {
        let model = sample_model(vec![]);
        let body = build_request_body(&model, json!({ "messages": [] }), false, Some("max"));

        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn stream_completion_accepts_done_or_normal_finish_reason() {
        assert!(resolve_stream_completion(true, None, true).is_ok());
        assert!(resolve_stream_completion(false, Some("stop"), true).is_ok());
        assert!(resolve_stream_completion(false, Some("tool_calls"), true).is_ok());
        assert!(resolve_stream_completion(false, Some("length"), true).is_ok());
        assert!(resolve_stream_completion(true, Some("stop"), false).is_ok());
    }

    #[test]
    fn stream_completion_rejects_incomplete_close() {
        let err = resolve_stream_completion(false, None, true).expect_err("incomplete");
        assert!(err.contains("incomplete") || err.contains("before the response finished"));

        let empty = resolve_stream_completion(false, None, false).expect_err("empty");
        assert!(empty.contains("without returning any content"));

        let filtered =
            resolve_stream_completion(false, Some("content_filter"), true).expect_err("filter");
        assert!(filtered.contains("content filter"));
    }

    #[test]
    fn utf8_stream_chunk_preserves_split_emoji() {
        let emoji = '\u{1F600}';
        let replacement = '\u{FFFD}';
        let text = "data: {\"choices\":[{\"delta\":{\"content\":\"hello \u{1F600}\"}}]}\n\n";
        let bytes = text.as_bytes();
        let emoji_start = text.find(emoji).expect("emoji index");
        let split = emoji_start + 1;
        let mut buffer = String::new();
        let mut pending = Vec::new();

        append_utf8_stream_chunk(&mut buffer, &mut pending, &bytes[..split]).expect("first chunk");
        assert!(!buffer.contains(replacement));
        assert!(!pending.is_empty());

        append_utf8_stream_chunk(&mut buffer, &mut pending, &bytes[split..]).expect("second chunk");
        assert!(pending.is_empty());
        assert_eq!(buffer, text);
        assert!(buffer.contains(emoji));
        assert!(!buffer.contains(replacement));
    }

    #[test]
    fn utf8_stream_chunk_keeps_incomplete_tail_pending() {
        let mut buffer = String::new();
        let mut pending = Vec::new();

        append_utf8_stream_chunk(&mut buffer, &mut pending, &[0xF0]).expect("partial");

        assert!(buffer.is_empty());
        assert_eq!(pending, vec![0xF0]);
    }

    #[test]
    fn extract_finish_reason_from_choice() {
        let payload = json!({
            "choices": [{ "delta": {}, "finish_reason": "tool_calls" }]
        });
        assert_eq!(
            extract_finish_reason(&payload).as_deref(),
            Some("tool_calls")
        );
        assert!(extract_finish_reason(&json!({"choices":[{"delta":{}}]})).is_none());
    }
}
