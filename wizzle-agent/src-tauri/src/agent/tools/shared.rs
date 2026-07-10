use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const MAX_COMMAND_OUTPUT_BYTES: usize = 120_000;
pub const MAX_TOOL_FILE_CONTENT_BYTES: usize = 60_000;
pub const MAX_READ_BYTES: usize = 51_200;
pub const MAX_READ_LINES: usize = 2_000;
pub const MAX_LINE_LENGTH: usize = 2_000;
pub const MAX_READ_SOURCE_BYTES: usize = 20 * 1024 * 1024;

#[derive(Clone, Copy, Default, Deserialize)]
pub enum ToolTimeout {
    #[serde(rename = "15s")]
    Seconds15,
    #[serde(rename = "30s")]
    #[default]
    Seconds30,
    #[serde(rename = "60s")]
    Seconds60,
    #[serde(rename = "120s")]
    Seconds120,
    #[serde(rename = "180s")]
    Seconds180,
}

impl ToolTimeout {
    pub fn duration(self) -> Duration {
        match self {
            Self::Seconds15 => Duration::from_secs(15),
            Self::Seconds30 => Duration::from_secs(30),
            Self::Seconds60 => Duration::from_secs(60),
            Self::Seconds120 => Duration::from_secs(120),
            Self::Seconds180 => Duration::from_secs(180),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Seconds15 => "15s",
            Self::Seconds30 => "30s",
            Self::Seconds60 => "60s",
            Self::Seconds120 => "120s",
            Self::Seconds180 => "180s",
        }
    }
}

pub fn truncate_text(text: String, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text, false);
    }

    let mut end_index = max_bytes;
    while !text.is_char_boundary(end_index) {
        end_index -= 1;
    }

    (text[..end_index].to_string(), true)
}

pub fn content_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub async fn run_blocking<T, F>(tool_name: &'static str, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let task_result = tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| format!("The {tool_name} tool task failed unexpectedly. {error}"))?;

    task_result
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use super::run_blocking;

    #[tokio::test]
    async fn blocking_operation_finishes_before_result_is_returned() {
        let finished = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let operation_finished = finished.clone();
        let result = run_blocking("test", move || {
            std::thread::sleep(Duration::from_millis(10));
            operation_finished.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok("finished")
        })
        .await
        .expect("operation result");

        assert_eq!(result, "finished");
        assert!(finished.load(std::sync::atomic::Ordering::SeqCst));
    }
}
