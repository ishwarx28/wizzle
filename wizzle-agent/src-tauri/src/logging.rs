use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::workspace::paths::{ensure_dir, wizzle_root_dir};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum LogLevel {
    Error,
    Info,
    Debug,
}

impl LogLevel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Info => "info",
            Self::Debug => "debug",
        }
    }
}

#[derive(Clone, Copy)]
enum LogMode {
    Off,
    Error,
    Info,
    Debug,
}

impl LogMode {
    fn allows(self, level: LogLevel) -> bool {
        match self {
            Self::Off => false,
            Self::Error => level <= LogLevel::Error,
            Self::Info => level <= LogLevel::Info,
            Self::Debug => level <= LogLevel::Debug,
        }
    }
}

struct DesktopLogConfig {
    frontend_log_path: PathBuf,
    frontend_retention_days: u64,
    mode: LogMode,
    path: PathBuf,
    retention_days: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendLogBatchInput {
    pub entries: Vec<FrontendLogEntryInput>,
    pub retention_days: Option<u64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendLogEntryInput {
    pub data: Option<Value>,
    pub event: String,
    pub level: String,
    pub scope: String,
    pub timestamp_ms: u64,
}

static DESKTOP_LOG_CONFIG: OnceLock<DesktopLogConfig> = OnceLock::new();

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_log_mode(raw_value: Option<String>) -> LogMode {
    match raw_value
        .unwrap_or_else(|| "debug".to_string())
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "off" => LogMode::Off,
        "error" => LogMode::Error,
        "debug" => LogMode::Debug,
        _ => LogMode::Info,
    }
}

fn load_desktop_log_config() -> DesktopLogConfig {
    let root = wizzle_root_dir().unwrap_or_else(|_| PathBuf::from(".wizzle"));
    let logs_dir = root.join("logs");
    let retention_days = env::var("WIZZLE_DESKTOP_LOG_RETENTION_DAYS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(7);
    let frontend_retention_days = env::var("WIZZLE_FRONTEND_LOG_RETENTION_DAYS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(retention_days);

    DesktopLogConfig {
        frontend_log_path: logs_dir.join("frontend.log"),
        frontend_retention_days,
        mode: parse_log_mode(env::var("WIZZLE_DESKTOP_LOG_MODE").ok()),
        path: logs_dir.join("desktop.log"),
        retention_days,
    }
}

fn desktop_log_config() -> &'static DesktopLogConfig {
    DESKTOP_LOG_CONFIG.get_or_init(load_desktop_log_config)
}

fn enforce_log_retention(path: &Path, retention_days: u64) {
    if retention_days == 0 || !path.exists() {
        return;
    }

    let max_age = Duration::from_secs(retention_days.saturating_mul(24 * 60 * 60));
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    let Ok(modified_at) = metadata.modified() else {
        return;
    };
    let Ok(elapsed) = modified_at.elapsed() else {
        return;
    };

    if elapsed >= max_age {
        let _ = fs::remove_file(path);
    }
}

fn append_log_line(path: &Path, retention_days: u64, payload: &Value) {
    if let Some(parent) = path.parent() {
        let _ = ensure_dir(parent);
    }

    enforce_log_retention(path, retention_days);

    let Ok(mut file) = OpenOptions::new().append(true).create(true).open(path) else {
        return;
    };
    let Ok(serialized) = serde_json::to_string(payload) else {
        return;
    };

    let _ = writeln!(file, "{serialized}");
}

pub fn log_desktop_event(level: &str, scope: &str, event: &str, data: Value) {
    let level = match level {
        "error" => LogLevel::Error,
        "debug" => LogLevel::Debug,
        _ => LogLevel::Info,
    };
    let config = desktop_log_config();

    if !config.mode.allows(level) {
        return;
    }

    append_log_line(
        &config.path,
        config.retention_days,
        &json!({
            "timestampMs": now_unix_ms(),
            "level": level.as_str(),
            "scope": scope,
            "event": event,
            "data": data,
        }),
    );
}

#[tauri::command]
pub fn write_frontend_logs(input: FrontendLogBatchInput) -> Result<(), String> {
    let config = desktop_log_config();
    let retention_days = input
        .retention_days
        .unwrap_or(config.frontend_retention_days);

    for entry in input.entries {
        let level = match entry.level.trim().to_ascii_lowercase().as_str() {
            "error" => LogLevel::Error,
            "debug" => LogLevel::Debug,
            _ => LogLevel::Info,
        };

        if !config.mode.allows(level) {
            continue;
        }

        append_log_line(
            &config.frontend_log_path,
            retention_days,
            &json!({
                "timestampMs": entry.timestamp_ms,
                "level": level.as_str(),
                "scope": entry.scope,
                "event": entry.event,
                "data": entry.data.unwrap_or(Value::Null),
            }),
        );
    }

    Ok(())
}
