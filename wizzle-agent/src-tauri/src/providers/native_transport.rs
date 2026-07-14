use futures_util::StreamExt;
use serde_json::Value;
use std::time::Duration;
use tauri::{Emitter, Window};

use super::openai_compatible::{
    map_provider_error, ProviderChatChunkKind, ProviderChatChunkPayload, ProviderRequestError,
    PROVIDER_CHAT_CHUNK_EVENT,
};

pub const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_RETRY_ATTEMPTS: usize = 2;
pub const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const RETRY_DELAYS_MS: [u64; MAX_RETRY_ATTEMPTS] = [250, 1000];

#[derive(Debug)]
pub struct SseEvent {
    pub data: String,
}

#[derive(Default)]
pub struct SseDecoder {
    buffer: String,
    pending_utf8: Vec<u8>,
}

impl SseDecoder {
    pub fn append(&mut self, bytes: &[u8]) -> Result<Vec<SseEvent>, String> {
        self.pending_utf8.extend_from_slice(bytes);

        loop {
            match std::str::from_utf8(&self.pending_utf8) {
                Ok(text) => {
                    self.buffer.push_str(text);
                    self.pending_utf8.clear();
                    break;
                }
                Err(error) if error.valid_up_to() > 0 => {
                    let valid_up_to = error.valid_up_to();
                    let text = std::str::from_utf8(&self.pending_utf8[..valid_up_to])
                        .map_err(|_| "Provider stream returned invalid UTF-8.".to_string())?;
                    self.buffer.push_str(text);
                    self.pending_utf8.drain(..valid_up_to);
                }
                Err(error) if error.error_len().is_some() => {
                    return Err("Provider stream returned invalid UTF-8.".to_string());
                }
                Err(_) => break,
            }
        }

        if self.buffer.len().saturating_add(self.pending_utf8.len()) > MAX_RESPONSE_BYTES {
            return Err("Provider stream exceeded the 10 MB safety limit.".to_string());
        }

        Ok(self.take_complete_events())
    }

    pub fn finish(mut self) -> Result<Vec<SseEvent>, String> {
        if !self.pending_utf8.is_empty() {
            return Err("Provider stream ended with incomplete UTF-8.".to_string());
        }

        let mut events = self.take_complete_events();
        if !self.buffer.trim().is_empty() {
            events.push(parse_sse_event(&self.buffer));
        }
        Ok(events)
    }

    fn take_complete_events(&mut self) -> Vec<SseEvent> {
        let normalized = self.buffer.replace("\r\n", "\n").replace('\r', "\n");
        let mut sections = normalized.split("\n\n").collect::<Vec<_>>();
        self.buffer = if normalized.ends_with("\n\n") {
            String::new()
        } else {
            sections.pop().unwrap_or_default().to_string()
        };

        sections
            .into_iter()
            .filter(|section| !section.trim().is_empty())
            .map(parse_sse_event)
            .collect()
    }
}

fn parse_sse_event(section: &str) -> SseEvent {
    let mut data = Vec::new();

    for line in section.lines() {
        if let Some(value) = line.strip_prefix("data:") {
            data.push(value.strip_prefix(' ').unwrap_or(value).to_string());
        }
    }

    SseEvent {
        data: data.join("\n"),
    }
}

pub fn endpoint_with_version(endpoint: &str, version: &str, path: &str) -> String {
    let endpoint = endpoint.trim_end_matches('/');
    let version = version.trim_matches('/');
    let path = path.trim_start_matches('/');
    let endpoint_lower = endpoint.to_ascii_lowercase();

    if endpoint_lower.ends_with(&format!("/{version}")) {
        format!("{endpoint}/{path}")
    } else {
        format!("{endpoint}/{version}/{path}")
    }
}

pub fn emit_chunks(
    window: &Window,
    request_id: &str,
    chunks: Vec<(ProviderChatChunkKind, String, Option<usize>)>,
) -> Result<usize, String> {
    let mut emitted = 0;
    for (kind, chunk, tool_call_index) in chunks {
        if chunk.is_empty() {
            continue;
        }
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
        emitted += 1;
    }
    Ok(emitted)
}

pub async fn response_text(response: reqwest::Response) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("Provider response exceeded the 10 MB safety limit.".to_string());
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| map_provider_error(None, "", Some(&error)).message)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("Provider response exceeded the 10 MB safety limit.".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }

    String::from_utf8(bytes).map_err(|_| "Provider returned invalid UTF-8.".to_string())
}

pub async fn checked_response(
    result: Result<reqwest::Response, reqwest::Error>,
) -> Result<reqwest::Response, ProviderRequestError> {
    let response = result.map_err(|error| map_provider_error(None, "", Some(&error)))?;
    if response.status().is_success() {
        return Ok(response);
    }

    let status = response.status().as_u16();
    let body = response_text(response)
        .await
        .map_err(|message| ProviderRequestError::new(message, false))?;
    Err(map_provider_error(Some(status), &body, None))
}

pub fn is_transient(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request() || error.is_body()
}

pub async fn wait_before_retry(attempt: usize) {
    if attempt == 0 || attempt > MAX_RETRY_ATTEMPTS {
        return;
    }
    tokio::time::sleep(Duration::from_millis(RETRY_DELAYS_MS[attempt - 1])).await;
}

pub fn parse_json(data: &str) -> Result<Value, String> {
    serde_json::from_str(data)
        .map_err(|_| "Provider stream returned an invalid response.".to_string())
}

#[cfg(test)]
mod tests {
    use super::{endpoint_with_version, SseDecoder};

    #[test]
    fn endpoint_does_not_duplicate_api_version() {
        assert_eq!(
            endpoint_with_version("https://example.test/v1", "v1", "messages"),
            "https://example.test/v1/messages"
        );
        assert_eq!(
            endpoint_with_version("https://example.test", "v1beta", "models"),
            "https://example.test/v1beta/models"
        );
    }

    #[test]
    fn sse_decoder_preserves_events_split_across_utf8_chunks() {
        let event = "event: content\ndata: {\"text\":\"😀\"}\n\n";
        let bytes = event.as_bytes();
        let split = event.find('😀').expect("emoji") + 1;
        let mut decoder = SseDecoder::default();

        assert!(decoder.append(&bytes[..split]).expect("first").is_empty());
        let events = decoder.append(&bytes[split..]).expect("second");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "{\"text\":\"😀\"}");
    }
}
