use serde::Serialize;
use std::time::Duration;
use tauri::{Emitter, Window};

use crate::logging::log_desktop_event;

pub const MAX_PROVIDER_RETRY_ATTEMPTS: usize = 5;
pub const PROVIDER_CHAT_RETRY_EVENT: &str = "provider-chat-retry";
const PROVIDER_RETRY_DELAYS_MS: [u64; MAX_PROVIDER_RETRY_ATTEMPTS] =
    [2_000, 4_000, 8_000, 16_000, 32_000];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderChatRetryPayload {
    attempt: usize,
    delay_ms: u64,
    max_attempts: usize,
    message: String,
    request_id: String,
}

pub fn can_retry_transport(attempt: usize, emitted_any_output: bool) -> bool {
    !emitted_any_output && attempt < MAX_PROVIDER_RETRY_ATTEMPTS
}

pub fn is_retryable_transport_error(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request() || error.is_body()
}

pub fn retry_display_message(message: &str) -> String {
    let normalized = message.trim().to_ascii_lowercase();

    if normalized.contains("timed out") {
        return "Provider response timed out. Retrying shortly.".to_string();
    }

    "Provider connection was interrupted. Retrying shortly.".to_string()
}

pub async fn notify_and_wait_for_retry(
    window: &Window,
    request_id: &str,
    attempt: usize,
    message: &str,
) {
    if attempt == 0 || attempt > MAX_PROVIDER_RETRY_ATTEMPTS {
        return;
    }

    let delay_ms = PROVIDER_RETRY_DELAYS_MS[attempt - 1];
    let display_message = retry_display_message(message);
    log_desktop_event(
        "info",
        "desktop.provider",
        "retry_scheduled",
        serde_json::json!({
            "attempt": attempt,
            "delayMs": delay_ms,
            "maxAttempts": MAX_PROVIDER_RETRY_ATTEMPTS,
            "requestIdLength": request_id.len(),
        }),
    );
    let _ = window.emit(
        PROVIDER_CHAT_RETRY_EVENT,
        ProviderChatRetryPayload {
            attempt,
            delay_ms,
            max_attempts: MAX_PROVIDER_RETRY_ATTEMPTS,
            message: display_message,
            request_id: request_id.to_string(),
        },
    );
    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
}

#[cfg(test)]
mod tests {
    use super::{
        can_retry_transport, retry_display_message, MAX_PROVIDER_RETRY_ATTEMPTS,
        PROVIDER_RETRY_DELAYS_MS,
    };

    #[test]
    fn uses_exact_exponential_retry_schedule() {
        assert_eq!(MAX_PROVIDER_RETRY_ATTEMPTS, 5);
        assert_eq!(
            PROVIDER_RETRY_DELAYS_MS,
            [2_000, 4_000, 8_000, 16_000, 32_000]
        );
    }

    #[test]
    fn retries_only_before_output_and_within_the_attempt_limit() {
        assert!(can_retry_transport(0, false));
        assert!(can_retry_transport(4, false));
        assert!(!can_retry_transport(5, false));
        assert!(!can_retry_transport(0, true));
    }

    #[test]
    fn retry_messages_do_not_expose_transport_details() {
        assert_eq!(
            retry_display_message("Error from provider (Console): Upstream request failed"),
            "Provider connection was interrupted. Retrying shortly."
        );
        assert_eq!(
            retry_display_message("Provider stream timed out"),
            "Provider response timed out. Retrying shortly."
        );
    }
}
