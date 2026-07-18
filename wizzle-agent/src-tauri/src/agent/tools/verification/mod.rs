mod adapters;
pub(crate) mod config;
mod diagnostics;
mod runner;
mod types;
mod watcher;

use std::{collections::HashSet, path::PathBuf};

use serde_json::Value;

use crate::agent::{types::AgentToolRunPayload, AgentRuntimeState};

pub use watcher::ChangeTracker;

use types::{VerificationCheckResult, VerificationReport};

pub async fn attach_for_changes(
    payload: AgentToolRunPayload,
    project_root: &std::path::Path,
    changed_paths: Vec<PathBuf>,
    runtime: &AgentRuntimeState,
    session_id: &str,
) -> AgentToolRunPayload {
    if changed_paths.is_empty() {
        return payload;
    }
    let report = verify_changes(project_root, changed_paths, runtime, session_id).await;
    attach_report(payload, report)
}

pub fn attach_unavailable(
    payload: AgentToolRunPayload,
    message: impl Into<String>,
) -> AgentToolRunPayload {
    attach_report(
        payload,
        VerificationReport::unavailable(Vec::new(), message.into()),
    )
}

async fn verify_changes(
    project_root: &std::path::Path,
    changed_paths: Vec<PathBuf>,
    runtime: &AgentRuntimeState,
    session_id: &str,
) -> VerificationReport {
    let mut paths = changed_paths
        .into_iter()
        .filter(|path| !path.is_dir() && path.starts_with(project_root))
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    let changed_files = paths
        .iter()
        .map(|path| display_path(project_root, path))
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return VerificationReport::skipped(
            changed_files,
            "No changed source files inside the selected project required verification.",
        );
    }

    let config = match config::load(project_root) {
        Ok(config) => config,
        Err(error) => return VerificationReport::unavailable(changed_files, error),
    };
    if !config.enabled {
        return VerificationReport::skipped(
            changed_files,
            "Automatic verification is disabled by the project configuration.",
        );
    }
    let checks = match adapters::discover(project_root, &paths, &config) {
        Ok(checks) => checks,
        Err(error) => return VerificationReport::unavailable(changed_files, error),
    };
    if checks.is_empty() {
        return VerificationReport::skipped(
            changed_files,
            "No installed verifier or configured adapter matched the changed files.",
        );
    }

    let mut results =
        runner::run_all(checks, config.max_diagnostics, Some((runtime, session_id))).await;
    apply_baselines(
        &mut results,
        runtime,
        session_id,
        project_root,
        config.max_diagnostics,
    );
    build_report(changed_files, results)
}

fn apply_baselines(
    checks: &mut [VerificationCheckResult],
    runtime: &AgentRuntimeState,
    session_id: &str,
    project_root: &std::path::Path,
    max_diagnostics: usize,
) {
    let mut remaining = max_diagnostics;
    for check in checks {
        let signatures = check
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.signature())
            .collect::<HashSet<_>>();
        let baseline_key = format!(
            "{}|{}|{}",
            session_id,
            project_root.to_string_lossy(),
            check.id
        );
        let previous = runtime
            .replace_verification_baseline(&baseline_key, signatures)
            .ok()
            .flatten();
        check.baseline_available = previous.is_some();
        for diagnostic in &mut check.diagnostics {
            diagnostic.is_new = previous
                .as_ref()
                .is_none_or(|baseline| !baseline.contains(&diagnostic.signature()));
        }
        if check.diagnostics.len() > remaining {
            check.diagnostics.truncate(remaining);
            check.truncated = true;
        }
        remaining = remaining.saturating_sub(check.diagnostics.len());
    }
}

fn build_report(
    changed_files: Vec<String>,
    checks: Vec<VerificationCheckResult>,
) -> VerificationReport {
    let diagnostics = checks
        .iter()
        .flat_map(|check| check.diagnostics.iter().cloned())
        .collect::<Vec<_>>();
    let diagnostic_count = diagnostics.len();
    let new_diagnostic_count = diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.is_new)
        .count();
    let has_failed = checks.iter().any(|check| check.status == "failed");
    let has_timeout = checks.iter().any(|check| check.status == "timed_out");
    let has_interrupted = checks.iter().any(|check| check.status == "interrupted");
    let has_passed = checks.iter().any(|check| check.status == "passed");
    let has_unavailable = checks.iter().any(|check| check.status == "unavailable");
    let status = if has_failed {
        "failed"
    } else if has_interrupted {
        "interrupted"
    } else if has_timeout {
        "timed_out"
    } else if has_passed && has_unavailable {
        "partial"
    } else if has_passed {
        "passed"
    } else {
        "unavailable"
    };
    let message = match status {
        "failed" if new_diagnostic_count > 0 => format!(
            "The change introduced {new_diagnostic_count} new diagnostic(s). Resolve them before continuing."
        ),
        "failed" => {
            "Verification failed, but every reported diagnostic was already present in the baseline."
                .to_string()
        }
        "timed_out" => {
            "Automatic verification timed out and terminated its verifier processes.".to_string()
        }
        "interrupted" => {
            "Automatic verification was interrupted and its verifier processes were terminated."
                .to_string()
        }
        "passed" if diagnostic_count > 0 => {
            "Automatic verification passed with non-error diagnostics.".to_string()
        }
        "passed" => "Automatic verification passed for the changed files.".to_string(),
        "partial" => {
            "Available checks passed, but at least one matching verifier was unavailable."
                .to_string()
        }
        _ => "Matching verifiers were unavailable; inspect each check message.".to_string(),
    };

    VerificationReport {
        changed_files,
        checks,
        diagnostic_count,
        diagnostics,
        message,
        new_diagnostic_count,
        status: status.to_string(),
    }
}

fn attach_report(
    mut payload: AgentToolRunPayload,
    report: VerificationReport,
) -> AgentToolRunPayload {
    let Some(output) = payload.output.as_deref() else {
        return payload;
    };
    let Ok(Value::Object(mut object)) = serde_json::from_str::<Value>(output) else {
        return payload;
    };
    object.insert(
        "verification".to_string(),
        serde_json::to_value(report).unwrap_or(Value::Null),
    );
    payload.output = Some(Value::Object(object).to_string());
    payload
}

fn display_path(project_root: &std::path::Path, path: &std::path::Path) -> String {
    path.strip_prefix(project_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use serde_json::json;

    use super::{attach_for_changes, attach_report, build_report};
    use crate::agent::{
        tools::{
            output,
            verification::types::{VerificationCheckResult, VerificationDiagnostic},
        },
        types::AgentToolRunPayload,
    };

    fn failed_check() -> VerificationCheckResult {
        VerificationCheckResult {
            baseline_available: true,
            command: "checker".into(),
            diagnostics: vec![VerificationDiagnostic {
                check_id: "check".into(),
                code: Some("E1".into()),
                column: Some(2),
                file: Some("src/main.ts".into()),
                is_new: true,
                line: Some(1),
                message: "Broken".into(),
                severity: "error".into(),
                source: "test".into(),
            }],
            duration_ms: 2,
            exit_code: Some(1),
            id: "check".into(),
            message: None,
            source: "test".into(),
            status: "failed".into(),
            timed_out: false,
            truncated: false,
        }
    }

    #[test]
    fn appends_failed_verification_without_failing_mutation() {
        let report = build_report(vec!["src/main.ts".into()], vec![failed_check()]);
        let payload = attach_report(output::success(json!({ "ok": true })), report);
        assert_eq!(payload.status, "done");
        assert!(payload.error.is_none());
        let output = serde_json::from_str::<serde_json::Value>(
            payload.output.as_deref().expect("tool output"),
        )
        .expect("valid output");
        assert_eq!(output["ok"], true);
        assert_eq!(output["verification"]["status"], "failed");
        assert_eq!(output["verification"]["newDiagnosticCount"], 1);
        assert_eq!(output["verification"]["diagnostics"][0]["code"], "E1");
    }

    #[test]
    fn leaves_non_json_payload_unchanged() {
        let payload = AgentToolRunPayload {
            error: None,
            output: Some("plain".into()),
            status: "done".into(),
        };
        let report = build_report(Vec::new(), vec![failed_check()]);
        assert_eq!(
            attach_report(payload, report).output.as_deref(),
            Some("plain")
        );
    }

    #[tokio::test]
    async fn runs_configured_check_and_diffs_session_baseline() {
        if cfg!(target_os = "windows") {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "wizzle-verification-integration-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create test project");
        let root = root.canonicalize().expect("canonical project");
        let source = root.join("main.foo");
        fs::write(&source, "broken\n").expect("write changed file");
        fs::write(
            root.join(".wizzle.yaml"),
            r#"verification:
  builtins: false
  commands:
    - id: fixture
      command: /bin/sh
      args: ["-c", "echo 'main.foo:1:1: error E1: Broken'; exit 1"]
      extensions: [foo]
      parser: generic
"#,
        )
        .expect("write verification config");
        let runtime = crate::agent::AgentRuntimeState::default();

        let first = attach_for_changes(
            output::success(json!({ "ok": true })),
            &root,
            vec![PathBuf::from(&source)],
            &runtime,
            "session-1",
        )
        .await;
        let first_output = serde_json::from_str::<serde_json::Value>(
            first.output.as_deref().expect("first output"),
        )
        .expect("valid first output");
        assert_eq!(first_output["verification"]["status"], "failed");
        assert_eq!(first_output["verification"]["newDiagnosticCount"], 1);

        let second = attach_for_changes(
            output::success(json!({ "ok": true })),
            &root,
            vec![source],
            &runtime,
            "session-1",
        )
        .await;
        let second_output = serde_json::from_str::<serde_json::Value>(
            second.output.as_deref().expect("second output"),
        )
        .expect("valid second output");
        assert_eq!(second_output["verification"]["newDiagnosticCount"], 0);
        assert_eq!(
            second_output["verification"]["checks"][0]["baselineAvailable"],
            true
        );
        let _ = fs::remove_dir_all(root);
    }
}
