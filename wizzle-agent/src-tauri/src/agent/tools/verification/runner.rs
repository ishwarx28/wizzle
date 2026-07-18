use std::{
    collections::VecDeque,
    io,
    process::Stdio,
    time::{Duration, Instant},
};

use futures_util::future::join_all;
use tokio::{io::AsyncReadExt, process::Command, task::JoinHandle};

use super::{
    diagnostics,
    types::{CheckSpec, VerificationCheckResult, VerificationDiagnostic},
};

const MAX_CHECK_OUTPUT_BYTES: usize = 128 * 1024;
const MAX_FAILURE_MESSAGE_CHARS: usize = 2_000;
const PROCESS_CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

struct BoundedStreamOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

struct CollectedVerifierOutput {
    exit_code: Option<i32>,
    interrupted: bool,
    stderr: BoundedStreamOutput,
    stdout: BoundedStreamOutput,
    success: bool,
    timed_out: bool,
}

pub async fn run_all(
    checks: Vec<CheckSpec>,
    max_diagnostics: usize,
    interruption: Option<(&crate::agent::AgentRuntimeState, &str)>,
) -> Vec<VerificationCheckResult> {
    join_all(
        checks
            .into_iter()
            .map(|check| run_check(check, max_diagnostics, interruption)),
    )
    .await
}

async fn run_check(
    check: CheckSpec,
    max_diagnostics: usize,
    interruption: Option<(&crate::agent::AgentRuntimeState, &str)>,
) -> VerificationCheckResult {
    let started = Instant::now();
    let mut command = build_verifier_command(&check);
    command
        .current_dir(&check.cwd)
        .env("CI", "1")
        .env("GOPROXY", "off")
        .env("NO_COLOR", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    command.process_group(0);

    #[cfg(target_os = "windows")]
    crate::agent::process_command::hide_tokio_console(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return unavailable_result(check, error, started.elapsed().as_millis() as u64)
        }
    };
    let execution = collect_verifier_output(&mut child, check.timeout_seconds, interruption).await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match execution {
        Err(error) => infrastructure_result(check, error, duration_ms),
        Ok(output) if output.interrupted => VerificationCheckResult {
            baseline_available: false,
            command: check.display_command,
            diagnostics: Vec::new(),
            duration_ms,
            exit_code: None,
            id: check.id,
            message: Some("Automatic verification was interrupted and its process tree was terminated.".to_string()),
            source: check.source,
            status: "interrupted".to_string(),
            timed_out: false,
            truncated: output.stdout.truncated || output.stderr.truncated,
        },
        Ok(output) if output.timed_out => {
            VerificationCheckResult {
                baseline_available: false,
                command: check.display_command,
                diagnostics: Vec::new(),
                duration_ms,
                exit_code: None,
                id: check.id,
                message: Some(format!(
                    "Verification timed out after {} seconds; the verifier process tree was terminated.",
                    check.timeout_seconds
                )),
                source: check.source,
                status: "timed_out".to_string(),
                timed_out: true,
                truncated: output.stdout.truncated || output.stderr.truncated,
            }
        }
        Ok(output) => {
            let (combined, truncated) = combine_output(&output.stdout, &output.stderr);
            if !output.success
                && !check.id.starts_with("custom:")
                && environment_is_unavailable(&combined)
            {
                return environment_unavailable_result(
                    check,
                    failure_excerpt(&combined),
                    duration_ms,
                    output.exit_code,
                    truncated,
                );
            }
            let mut diagnostics = diagnostics::parse(
                check.parser,
                &combined,
                &check.id,
                &check.source,
                &check.cwd,
            );
            let failed = !output.success
                || diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.severity == "error");
            let message = if failed && diagnostics.is_empty() {
                let message = failure_excerpt(&combined);
                diagnostics.push(VerificationDiagnostic {
                    check_id: check.id.clone(),
                    code: Some("process_exit".to_string()),
                    column: None,
                    file: None,
                    is_new: false,
                    line: None,
                    message: message.clone(),
                    severity: "error".to_string(),
                    source: check.source.clone(),
                });
                Some(message)
            } else {
                None
            };
            let diagnostics_truncated = diagnostics.len() > max_diagnostics;
            diagnostics.truncate(max_diagnostics);

            VerificationCheckResult {
                baseline_available: false,
                command: check.display_command,
                diagnostics,
                duration_ms,
                exit_code: output.exit_code,
                id: check.id,
                message,
                source: check.source,
                status: if failed { "failed" } else { "passed" }.to_string(),
                timed_out: false,
                truncated: truncated || diagnostics_truncated,
            }
        }
    }
}

async fn collect_verifier_output(
    child: &mut tokio::process::Child,
    timeout_seconds: u64,
    interruption: Option<(&crate::agent::AgentRuntimeState, &str)>,
) -> Result<CollectedVerifierOutput, String> {
    let pid = child
        .id()
        .ok_or_else(|| "Could not determine the verifier process ID.".to_string())?;
    let stdout_task = tokio::spawn(read_bounded_stream(child.stdout.take()));
    let stderr_task = tokio::spawn(read_bounded_stream(child.stderr.take()));
    enum Completion {
        Finished(Result<std::process::ExitStatus, io::Error>),
        Interrupted,
        TimedOut,
    }
    let completion = tokio::select! {
        result = child.wait() => Completion::Finished(result),
        _ = tokio::time::sleep(Duration::from_secs(timeout_seconds)) => Completion::TimedOut,
        _ = wait_for_interruption(interruption) => Completion::Interrupted,
    };
    let timed_out = matches!(completion, Completion::TimedOut);
    let interrupted = matches!(completion, Completion::Interrupted);

    let wait_outcome = match completion {
        Completion::Finished(Ok(status)) => Ok((status, false, false)),
        Completion::Finished(Err(error)) => {
            let _ = crate::agent::runtime::terminate_pid(pid).await;
            let _ = tokio::time::timeout(PROCESS_CLEANUP_TIMEOUT, child.wait()).await;
            Err(format!("Could not wait for the verifier: {error}"))
        }
        Completion::Interrupted | Completion::TimedOut => {
            match crate::agent::runtime::terminate_pid(pid).await {
                Ok(()) => tokio::time::timeout(PROCESS_CLEANUP_TIMEOUT, child.wait())
                    .await
                    .map_err(|_| "Timed out while reaping the verifier process.".to_string())
                    .and_then(|result| {
                        result
                            .map(|status| (status, timed_out, interrupted))
                            .map_err(|error| {
                                format!("Could not reap the verifier process: {error}")
                            })
                    }),
                Err(error) => {
                    let _ = child.start_kill();
                    let _ = tokio::time::timeout(PROCESS_CLEANUP_TIMEOUT, child.wait()).await;
                    Err(format!(
                        "Could not terminate the timed-out verifier: {error}"
                    ))
                }
            }
        }
    };
    let (stdout, stderr) = tokio::join!(
        finish_stream_task(stdout_task, "stdout"),
        finish_stream_task(stderr_task, "stderr")
    );
    let (status, timed_out, interrupted) = wait_outcome?;
    Ok(CollectedVerifierOutput {
        exit_code: status.code(),
        interrupted,
        stderr: stderr?,
        stdout: stdout?,
        success: status.success(),
        timed_out,
    })
}

async fn wait_for_interruption(interruption: Option<(&crate::agent::AgentRuntimeState, &str)>) {
    loop {
        if interruption.is_some_and(|(runtime, session_id)| runtime.is_interrupted(session_id)) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn read_bounded_stream<T>(stream: Option<T>) -> Result<BoundedStreamOutput, io::Error>
where
    T: tokio::io::AsyncRead + Unpin,
{
    let Some(mut stream) = stream else {
        return Ok(BoundedStreamOutput {
            bytes: Vec::new(),
            truncated: false,
        });
    };
    let max_bytes = MAX_CHECK_OUTPUT_BYTES / 2;
    let segment_bytes = max_bytes / 2;
    let mut head = Vec::with_capacity(segment_bytes);
    let mut tail = VecDeque::<u8>::with_capacity(segment_bytes);
    let mut buffer = [0_u8; 4_096];
    let mut total_bytes = 0_usize;
    loop {
        let read = stream.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(read);
        let head_remaining = segment_bytes.saturating_sub(head.len());
        let head_bytes = head_remaining.min(read);
        head.extend_from_slice(&buffer[..head_bytes]);
        tail.extend(buffer[head_bytes..read].iter().copied());
        while tail.len() > segment_bytes {
            tail.pop_front();
        }
    }
    let truncated = total_bytes > max_bytes;
    let mut bytes = head;
    if truncated {
        bytes.extend_from_slice(b"\n... verifier output omitted ...\n");
    }
    bytes.extend(tail);
    Ok(BoundedStreamOutput { bytes, truncated })
}

async fn finish_stream_task(
    mut task: JoinHandle<Result<BoundedStreamOutput, io::Error>>,
    label: &str,
) -> Result<BoundedStreamOutput, String> {
    match tokio::time::timeout(PROCESS_CLEANUP_TIMEOUT, &mut task).await {
        Ok(Ok(Ok(output))) => Ok(output),
        Ok(Ok(Err(error))) => Err(format!("Could not read verifier {label}: {error}")),
        Ok(Err(error)) => Err(format!("Could not collect verifier {label}: {error}")),
        Err(_) => {
            task.abort();
            Err(format!("Timed out while closing verifier {label}."))
        }
    }
}

fn build_verifier_command(check: &CheckSpec) -> Command {
    #[cfg(target_os = "windows")]
    if matches!(
        check.program.extension().and_then(|value| value.to_str()),
        Some(extension) if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
    ) {
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$wizzleArgs = @(ConvertFrom-Json $env:WIZZLE_VERIFIER_ARGS_JSON); & $env:WIZZLE_VERIFIER_PROGRAM @wizzleArgs; exit $LASTEXITCODE",
            ])
            .env(
                "WIZZLE_VERIFIER_PROGRAM",
                check.program.to_string_lossy().to_string(),
            )
            .env(
                "WIZZLE_VERIFIER_ARGS_JSON",
                serde_json::to_string(&check.args).unwrap_or_else(|_| "[]".to_string()),
            );
        return command;
    }

    let mut command = Command::new(&check.program);
    command.args(&check.args);
    command
}

fn unavailable_result(
    check: CheckSpec,
    error: io::Error,
    duration_ms: u64,
) -> VerificationCheckResult {
    let message = if error.kind() == io::ErrorKind::NotFound {
        format!(
            "The {} verifier is not installed or is not available on PATH.",
            check.source
        )
    } else {
        format!("Could not start the {} verifier: {error}", check.source)
    };
    VerificationCheckResult {
        baseline_available: false,
        command: check.display_command,
        diagnostics: Vec::new(),
        duration_ms,
        exit_code: None,
        id: check.id,
        message: Some(message),
        source: check.source,
        status: "unavailable".to_string(),
        timed_out: false,
        truncated: false,
    }
}

fn infrastructure_result(
    check: CheckSpec,
    message: String,
    duration_ms: u64,
) -> VerificationCheckResult {
    VerificationCheckResult {
        baseline_available: false,
        command: check.display_command,
        diagnostics: Vec::new(),
        duration_ms,
        exit_code: None,
        id: check.id,
        message: Some(message),
        source: check.source,
        status: "unavailable".to_string(),
        timed_out: false,
        truncated: false,
    }
}

fn environment_unavailable_result(
    check: CheckSpec,
    details: String,
    duration_ms: u64,
    exit_code: Option<i32>,
    truncated: bool,
) -> VerificationCheckResult {
    VerificationCheckResult {
        baseline_available: false,
        command: check.display_command,
        diagnostics: Vec::new(),
        duration_ms,
        exit_code,
        id: check.id,
        message: Some(format!(
            "Required SDK components or cached dependencies are unavailable. Wizzle did not download or install them. {details}"
        )),
        source: check.source,
        status: "unavailable".to_string(),
        timed_out: false,
        truncated,
    }
}

fn environment_is_unavailable(output: &str) -> bool {
    let normalized = output.to_ascii_lowercase();
    [
        "assets file 'obj/project.assets.json' not found",
        "could not resolve all files",
        "could not resolve dependencies",
        "disableautomaticpackageresolution",
        "failed to download",
        "module lookup disabled by goproxy=off",
        "no cached version",
        "no matching package named",
        "not available for offline mode",
        "package_config.json does not exist",
        "run a nuget package restore",
        "unable to find a destination",
        "xcodebuild: error: sdk",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
        || normalized.contains("offline") && normalized.contains("dependency")
        || normalized.contains("task '") && normalized.contains("not found in")
        || normalized.contains("nu1101")
}

fn combine_output(stdout: &BoundedStreamOutput, stderr: &BoundedStreamOutput) -> (String, bool) {
    let truncated = stdout.truncated || stderr.truncated;
    let stdout = String::from_utf8_lossy(&stdout.bytes);
    let stderr = String::from_utf8_lossy(&stderr.bytes);
    let combined = if stdout.is_empty() {
        stderr.to_string()
    } else if stderr.is_empty() {
        stdout.to_string()
    } else {
        format!("{stdout}\n{stderr}")
    };
    (combined, truncated)
}

fn failure_excerpt(output: &str) -> String {
    let compact = output
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let value = if compact.trim().is_empty() {
        "The verifier exited unsuccessfully without diagnostics.".to_string()
    } else {
        compact
    };
    value
        .chars()
        .rev()
        .take(MAX_FAILURE_MESSAGE_CHARS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{environment_is_unavailable, run_all};
    use crate::agent::tools::verification::types::{CheckSpec, DiagnosticParser};

    #[tokio::test]
    async fn returns_structured_failure_for_unparsed_nonzero_exit() {
        if cfg!(target_os = "windows") {
            return;
        }
        let result = run_all(
            vec![CheckSpec {
                args: vec!["-c".into(), "echo broken >&2; exit 2".into()],
                cwd: std::env::temp_dir(),
                display_command: "sh -c failure".into(),
                id: "test".into(),
                parser: DiagnosticParser::Generic,
                program: PathBuf::from("/bin/sh"),
                source: "test".into(),
                timeout_seconds: 2,
            }],
            10,
            None,
        )
        .await;
        assert_eq!(result[0].status, "failed");
        assert_eq!(result[0].diagnostics.len(), 1);
        assert_eq!(
            result[0].diagnostics[0].code.as_deref(),
            Some("process_exit")
        );
    }

    #[tokio::test]
    async fn terminates_timed_out_verifier() {
        if cfg!(target_os = "windows") {
            return;
        }
        let result = run_all(
            vec![CheckSpec {
                args: vec!["-c".into(), "sleep 5".into()],
                cwd: std::env::temp_dir(),
                display_command: "sh -c sleep".into(),
                id: "timeout".into(),
                parser: DiagnosticParser::Generic,
                program: PathBuf::from("/bin/sh"),
                source: "test".into(),
                timeout_seconds: 1,
            }],
            10,
            None,
        )
        .await;
        assert_eq!(result[0].status, "timed_out");
        assert!(result[0].timed_out);
    }

    #[tokio::test]
    async fn bounds_noisy_verifier_output_while_draining_streams() {
        if cfg!(target_os = "windows") {
            return;
        }
        let result = run_all(
            vec![CheckSpec {
                args: vec![
                    "-c".into(),
                    "head -c 100000 /dev/zero | tr '\\0' x; exit 1".into(),
                ],
                cwd: std::env::temp_dir(),
                display_command: "noisy verifier".into(),
                id: "noisy".into(),
                parser: DiagnosticParser::Generic,
                program: PathBuf::from("/bin/sh"),
                source: "test".into(),
                timeout_seconds: 2,
            }],
            10,
            None,
        )
        .await;
        assert_eq!(result[0].status, "failed");
        assert!(result[0].truncated);
        assert!(result[0].diagnostics[0].message.len() <= 2_000);
    }

    #[test]
    fn distinguishes_missing_offline_dependencies_from_code_errors() {
        assert!(environment_is_unavailable(
            "module lookup disabled by GOPROXY=off"
        ));
        assert!(environment_is_unavailable(
            "Task ':app:compileDebugKotlin' not found in project"
        ));
        assert!(!environment_is_unavailable(
            "src/main.ts:1:1: error TS2322: Wrong type"
        ));
    }
}
