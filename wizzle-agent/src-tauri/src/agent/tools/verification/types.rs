use std::path::PathBuf;

use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticParser {
    Cargo,
    Dart,
    Eslint,
    Flutter,
    Generic,
    Pyright,
    Ruff,
}

#[derive(Clone, Debug)]
pub struct CheckSpec {
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub display_command: String,
    pub id: String,
    pub parser: DiagnosticParser,
    pub program: PathBuf,
    pub source: String,
    pub timeout_seconds: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationDiagnostic {
    pub check_id: String,
    pub code: Option<String>,
    pub column: Option<u64>,
    pub file: Option<String>,
    pub is_new: bool,
    pub line: Option<u64>,
    pub message: String,
    pub severity: String,
    pub source: String,
}

impl VerificationDiagnostic {
    pub fn signature(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}|{}|{}",
            self.file.as_deref().unwrap_or_default(),
            self.line.unwrap_or_default(),
            self.column.unwrap_or_default(),
            self.severity,
            self.code.as_deref().unwrap_or_default(),
            self.source,
            self.message
        )
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationCheckResult {
    pub baseline_available: bool,
    pub command: String,
    #[serde(skip_serializing)]
    pub diagnostics: Vec<VerificationDiagnostic>,
    pub duration_ms: u64,
    pub exit_code: Option<i32>,
    pub id: String,
    pub message: Option<String>,
    pub source: String,
    pub status: String,
    pub timed_out: bool,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReport {
    pub changed_files: Vec<String>,
    pub checks: Vec<VerificationCheckResult>,
    pub diagnostic_count: usize,
    pub diagnostics: Vec<VerificationDiagnostic>,
    pub message: String,
    pub new_diagnostic_count: usize,
    pub status: String,
}

impl VerificationReport {
    pub fn skipped(changed_files: Vec<String>, message: impl Into<String>) -> Self {
        Self {
            changed_files,
            checks: Vec::new(),
            diagnostic_count: 0,
            diagnostics: Vec::new(),
            message: message.into(),
            new_diagnostic_count: 0,
            status: "skipped".to_string(),
        }
    }

    pub fn unavailable(changed_files: Vec<String>, message: impl Into<String>) -> Self {
        Self {
            changed_files,
            checks: Vec::new(),
            diagnostic_count: 0,
            diagnostics: Vec::new(),
            message: message.into(),
            new_diagnostic_count: 0,
            status: "unavailable".to_string(),
        }
    }
}
