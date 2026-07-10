use std::{
    io,
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Window};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    sync::mpsc,
};
use uuid::Uuid;

use super::{
    output, pathing,
    shared::{truncate_text, ToolTimeout, MAX_COMMAND_OUTPUT_BYTES},
};
use crate::{
    agent::{runtime::terminate_pid, types::AgentToolRunPayload, AgentRuntimeState},
    workspace::sqlite_repository::{self, NewProcessRecord, WorkspaceProcessPayload},
};

const AGENT_TOOL_CHUNK_EVENT: &str = "agent-tool-chunk";
const MAX_STREAM_CAPTURE_BYTES: usize = MAX_COMMAND_OUTPUT_BYTES / 2;
const PROCESS_CLEANUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Clone, Copy, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum BashAction {
    ListProcesses,
    ReadProcess,
    Run,
    StopProcess,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BashToolArguments {
    action: Option<BashAction>,
    background: Option<bool>,
    command: Option<String>,
    cwd: Option<String>,
    process_id: Option<String>,
    timeout: Option<ToolTimeout>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentToolChunkPayload {
    chunk: String,
    stream: BashOutputStream,
    tool_call_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum BashOutputStream {
    Stderr,
    Stdout,
}

struct OutputChunk {
    stream: BashOutputStream,
    text: String,
}

struct CollectedOutput {
    combined_output: String,
    status: ExitStatus,
    stderr: String,
    stdout: String,
    timed_out: bool,
    truncated: bool,
}

struct ProcessCompletion {
    status: ExitStatus,
    timed_out: bool,
}

pub async fn run(
    project_root: PathBuf,
    arguments: Value,
    tool_call_id: Option<&str>,
    window: &Window,
    runtime: &AgentRuntimeState,
    session_id: Option<&str>,
    turn_id: Option<&str>,
) -> Result<AgentToolRunPayload, String> {
    let arguments: BashToolArguments = serde_json::from_value(arguments)
        .map_err(|error| format!("Invalid arguments for bash: {error}"))?;
    let action = arguments.action.unwrap_or(BashAction::Run);

    match action {
        BashAction::Run => {
            run_command(
                project_root,
                arguments,
                tool_call_id,
                window,
                runtime,
                session_id,
                turn_id,
            )
            .await
        }
        BashAction::ListProcesses => {
            let session_id = require_session_id(session_id)?;
            let processes = sqlite_repository::list_processes(session_id)?;
            Ok(output::success(json!({
                "ok": true,
                "processes": processes,
            })))
        }
        BashAction::ReadProcess => {
            let session_id = require_session_id(session_id)?;
            let process_id = require_process_id(&arguments)?;
            let process = sqlite_repository::read_process(session_id, process_id)?;
            Ok(output::success(json!({
                "ok": true,
                "process": process,
            })))
        }
        BashAction::StopProcess => {
            let session_id = require_session_id(session_id)?;
            let process_id = require_process_id(&arguments)?;
            let process = runtime.stop_process(window, session_id, process_id).await?;
            Ok(output::success(json!({
                "ok": true,
                "process": process,
            })))
        }
    }
}

fn require_session_id(session_id: Option<&str>) -> Result<&str, String> {
    session_id.ok_or_else(|| "A stored session is required for bash process actions.".to_string())
}

fn require_process_id(arguments: &BashToolArguments) -> Result<&str, String> {
    arguments
        .process_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The bash process action requires processId.".to_string())
}

fn require_command(arguments: &BashToolArguments) -> Result<String, String> {
    arguments
        .command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "The bash run action requires command.".to_string())
}

fn command_looks_unsafe(command: &str) -> Option<&'static str> {
    let normalized = command.trim().to_ascii_lowercase();

    if normalized.contains("nohup ")
        || normalized.contains(" disown")
        || normalized.contains(" setsid ")
        || normalized.ends_with('&')
    {
        return Some("Use background: true instead of shell background syntax.");
    }

    for marker in [
        "sudo ",
        "shutdown",
        "reboot",
        "poweroff",
        "halt",
        "mkfs",
        "dd if=",
        "diskutil erase",
        "rm -rf /",
        "rm -rf ~",
        ":(){",
    ] {
        if normalized.contains(marker) {
            return Some("That command is too destructive to run from Wizzle.");
        }
    }

    None
}

fn build_shell_command(command: &str) -> Command {
    if cfg!(target_os = "windows") {
        let mut process = Command::new("cmd");
        process.args(["/C", command]);
        process
    } else {
        let mut process = Command::new("sh");
        process.args(["-lc", command]);
        // Own process group so stop can kill the shell and its children (http.server, etc.).
        #[cfg(unix)]
        {
            process.process_group(0);
        }
        process
    }
}

fn resolve_command_cwd(project_root: &Path, cwd: Option<&str>) -> Result<PathBuf, String> {
    let Some(cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(project_root.to_path_buf());
    };
    let path = pathing::resolve_existing_path(project_root, cwd)?;

    if !path.is_dir() {
        return Err(format!(
            "The bash cwd {} is not a directory.",
            path.display()
        ));
    }

    Ok(path)
}

fn append_with_limit(buffer: &mut String, chunk: &str, max_bytes: usize) -> bool {
    if chunk.is_empty() {
        return false;
    }

    if buffer.len() >= max_bytes {
        return true;
    }

    let available_bytes = max_bytes.saturating_sub(buffer.len());

    if chunk.len() <= available_bytes {
        buffer.push_str(chunk);
        return false;
    }

    let mut end_index = available_bytes;
    while end_index > 0 && !chunk.is_char_boundary(end_index) {
        end_index -= 1;
    }

    buffer.push_str(&chunk[..end_index]);
    true
}

async fn read_child_stream<T>(
    stream: Option<T>,
    sender: mpsc::UnboundedSender<OutputChunk>,
    output_stream: BashOutputStream,
) -> Result<(), io::Error>
where
    T: tokio::io::AsyncRead + Unpin,
{
    let Some(mut stream) = stream else {
        return Ok(());
    };

    let mut buffer = vec![0_u8; 4096];

    loop {
        let read_bytes = stream.read(&mut buffer).await?;

        if read_bytes == 0 {
            break;
        }

        if sender
            .send(OutputChunk {
                stream: output_stream.clone(),
                text: String::from_utf8_lossy(&buffer[..read_bytes]).to_string(),
            })
            .is_err()
        {
            break;
        }
    }

    Ok(())
}

async fn wait_for_child(
    mut child: Child,
    timeout: ToolTimeout,
) -> Result<ProcessCompletion, String> {
    let pid = child
        .id()
        .ok_or_else(|| "Could not determine the command process ID.".to_string())?;
    let mut timed_out = false;
    let status = match tokio::time::timeout(timeout.duration(), child.wait()).await {
        Ok(result) => {
            result.map_err(|error| format!("Could not wait for the command to finish: {error}"))?
        }
        Err(_) => {
            timed_out = true;
            tokio::time::timeout(PROCESS_CLEANUP_TIMEOUT, terminate_pid(pid))
                .await
                .map_err(|_| {
                    "Timed out while terminating the command process group.".to_string()
                })??;
            tokio::time::timeout(PROCESS_CLEANUP_TIMEOUT, child.wait())
                .await
                .map_err(|_| "Timed out while reaping the terminated command.".to_string())?
                .map_err(|error| {
                    format!("Could not finish the timed-out command cleanup: {error}")
                })?
        }
    };

    Ok(ProcessCompletion { status, timed_out })
}

async fn collect_output(
    mut child: Child,
    timeout: ToolTimeout,
    tool_call_id: Option<&str>,
    window: &Window,
) -> Result<CollectedOutput, String> {
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let stdout_task = tokio::spawn(read_child_stream(
        child.stdout.take(),
        sender.clone(),
        BashOutputStream::Stdout,
    ));
    let stderr_task = tokio::spawn(read_child_stream(
        child.stderr.take(),
        sender.clone(),
        BashOutputStream::Stderr,
    ));
    drop(sender);

    let mut wait_task = tokio::spawn(wait_for_child(child, timeout));
    let mut wait_result: Option<ProcessCompletion> = None;
    let mut streams_closed = false;
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut combined_output = String::new();
    let mut stdout_truncated = false;
    let mut stderr_truncated = false;
    let mut combined_truncated = false;

    while wait_result.is_none() || !streams_closed {
        tokio::select! {
            maybe_chunk = receiver.recv(), if !streams_closed => {
                match maybe_chunk {
                    Some(chunk) => {
                        if let Some(tool_call_id) = tool_call_id {
                            let _ = window.emit(
                                AGENT_TOOL_CHUNK_EVENT,
                                AgentToolChunkPayload {
                                    chunk: chunk.text.clone(),
                                    stream: chunk.stream.clone(),
                                    tool_call_id: tool_call_id.to_string(),
                                },
                            );
                        }

                        match chunk.stream {
                            BashOutputStream::Stdout => {
                                stdout_truncated |= append_with_limit(
                                    &mut stdout,
                                    &chunk.text,
                                    MAX_STREAM_CAPTURE_BYTES,
                                );
                            }
                            BashOutputStream::Stderr => {
                                stderr_truncated |= append_with_limit(
                                    &mut stderr,
                                    &chunk.text,
                                    MAX_STREAM_CAPTURE_BYTES,
                                );
                            }
                        }

                        combined_truncated |= append_with_limit(
                            &mut combined_output,
                            &chunk.text,
                            MAX_COMMAND_OUTPUT_BYTES,
                        );
                    }
                    None => {
                        streams_closed = true;
                    }
                }
            }
            result = &mut wait_task, if wait_result.is_none() => {
                wait_result = Some(
                    result
                        .map_err(|error| format!("Could not monitor the command execution: {error}"))?
                        ?,
                );
            }
        }
    }

    tokio::time::timeout(PROCESS_CLEANUP_TIMEOUT, stdout_task)
        .await
        .map_err(|_| "Timed out while closing command stdout after process cleanup.".to_string())?
        .map_err(|error| format!("Could not collect command stdout: {error}"))?
        .map_err(|error| format!("Could not read command stdout: {error}"))?;
    tokio::time::timeout(PROCESS_CLEANUP_TIMEOUT, stderr_task)
        .await
        .map_err(|_| "Timed out while closing command stderr after process cleanup.".to_string())?
        .map_err(|error| format!("Could not collect command stderr: {error}"))?
        .map_err(|error| format!("Could not read command stderr: {error}"))?;

    let wait_result =
        wait_result.ok_or_else(|| "Could not determine when the command finished.".to_string())?;

    Ok(CollectedOutput {
        combined_output,
        status: wait_result.status,
        stderr,
        stdout,
        timed_out: wait_result.timed_out,
        truncated: stdout_truncated || stderr_truncated || combined_truncated,
    })
}

async fn run_command(
    project_root: PathBuf,
    arguments: BashToolArguments,
    tool_call_id: Option<&str>,
    window: &Window,
    runtime: &AgentRuntimeState,
    session_id: Option<&str>,
    turn_id: Option<&str>,
) -> Result<AgentToolRunPayload, String> {
    let command = require_command(&arguments)?;

    if let Some(message) = command_looks_unsafe(&command) {
        return Err(message.to_string());
    }

    let cwd = resolve_command_cwd(&project_root, arguments.cwd.as_deref())?;

    if arguments.background.unwrap_or(false) {
        let session_id = require_session_id(session_id)?;
        let lock = runtime.background_process_lock(session_id)?;
        let _guard = lock.lock().await;
        return start_background_process(
            session_id,
            command,
            cwd,
            window,
            runtime,
            turn_id,
            tool_call_id,
        )
        .await;
    }

    let session_key = session_id
        .map(str::to_string)
        .unwrap_or_else(|| project_root.to_string_lossy().to_string());
    let lock = runtime.foreground_bash_lock(&session_key)?;
    let _guard = lock.lock().await;
    execute_foreground(
        command,
        cwd,
        arguments.timeout.unwrap_or_default(),
        tool_call_id,
        window,
        runtime,
        session_id,
    )
    .await
}

async fn execute_foreground(
    command_text: String,
    cwd: PathBuf,
    timeout: ToolTimeout,
    tool_call_id: Option<&str>,
    window: &Window,
    runtime: &AgentRuntimeState,
    session_id: Option<&str>,
) -> Result<AgentToolRunPayload, String> {
    let mut command = build_shell_command(&command_text);
    command
        .current_dir(&cwd)
        .env("PWD", &cwd)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = command
        .spawn()
        .map_err(|error| format!("Could not run the command: {error}"))?;
    let pid = child.id();

    if let (Some(session_id), Some(pid)) = (session_id, pid) {
        runtime.register_foreground_process(session_id, pid)?;
    }

    let collected_output = collect_output(child, timeout, tool_call_id, window).await;

    if let (Some(session_id), Some(pid)) = (session_id, pid) {
        runtime.unregister_foreground_process(session_id, pid);
    }

    let collected_output = collected_output?;
    let (truncated_stdout, stdout_truncated) =
        truncate_text(collected_output.stdout, MAX_STREAM_CAPTURE_BYTES);
    let (truncated_stderr, stderr_truncated) =
        truncate_text(collected_output.stderr, MAX_STREAM_CAPTURE_BYTES);
    let (truncated_combined_output, combined_output_truncated) =
        truncate_text(collected_output.combined_output, MAX_COMMAND_OUTPUT_BYTES);
    let is_truncated = collected_output.truncated
        || stdout_truncated
        || stderr_truncated
        || combined_output_truncated;
    let details = json!({
        "command": command_text,
        "cwd": cwd.to_string_lossy(),
        "exitCode": collected_output.status.code(),
        "combinedOutput": truncated_combined_output,
        "stdout": truncated_stdout,
        "stderr": truncated_stderr,
        "timeout": timeout.label(),
        "timedOut": collected_output.timed_out,
        "truncated": is_truncated,
    });

    if let Some(session_id) = session_id {
        if runtime.is_interrupted(session_id) {
            return Ok(AgentToolRunPayload {
                error: Some("The bash tool was interrupted.".to_string()),
                output: Some(
                    json!({
                        "ok": false,
                        "interrupted": true,
                        "details": details,
                    })
                    .to_string(),
                ),
                status: "interrupted".to_string(),
            });
        }
    }

    if collected_output.timed_out {
        return Ok(output::error_with_output(
            format!("The bash tool timed out after {}.", timeout.label()),
            details,
        ));
    }

    Ok(output::success(json!({
        "ok": collected_output.status.success(),
        "command": command_text,
        "cwd": cwd.to_string_lossy(),
        "exitCode": collected_output.status.code(),
        "combinedOutput": details["combinedOutput"].clone(),
        "stdout": details["stdout"].clone(),
        "stderr": details["stderr"].clone(),
        "timeout": timeout.label(),
        "timedOut": false,
        "truncated": is_truncated,
    })))
}

async fn start_background_process(
    session_id: &str,
    command_text: String,
    cwd: PathBuf,
    window: &Window,
    runtime: &AgentRuntimeState,
    turn_id: Option<&str>,
    tool_call_id: Option<&str>,
) -> Result<AgentToolRunPayload, String> {
    let mut command = build_shell_command(&command_text);
    command
        .current_dir(&cwd)
        .env("PWD", &cwd)
        .kill_on_drop(false)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the background command: {error}"))?;
    let pid = child
        .id()
        .ok_or_else(|| "Could not determine the background process ID.".to_string())?;
    let process_id = format!("process-{}", Uuid::new_v4());
    let process = match sqlite_repository::insert_process(NewProcessRecord {
        command: command_text,
        cwd: cwd.to_string_lossy().to_string(),
        id: process_id.clone(),
        pid: Some(pid),
        session_id: session_id.to_string(),
        started_at_ms: sqlite_repository::now_unix_ms(),
        status: "running".to_string(),
        tool_call_id: tool_call_id.map(str::to_string),
        turn_id: turn_id.map(str::to_string),
    }) {
        Ok(process) => process,
        Err(error) => {
            let _ = child.kill().await;
            return Err(error);
        }
    };

    if let Err(error) = runtime.register_background_process(session_id, &process_id, pid) {
        let _ = child.kill().await;
        let _ = sqlite_repository::mark_process_interrupted(session_id, &process_id);
        return Err(error);
    }

    runtime.emit_process_update(window, process.clone());
    spawn_background_monitor(child, process_id.clone(), window.clone(), runtime.clone());

    Ok(output::success(json!({
        "ok": true,
        "background": true,
        "process": process,
    })))
}

fn spawn_background_monitor(
    mut child: Child,
    process_id: String,
    window: Window,
    runtime: AgentRuntimeState,
) {
    tokio::spawn(async move {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let stdout_task = tokio::spawn(read_child_stream(
            child.stdout.take(),
            sender.clone(),
            BashOutputStream::Stdout,
        ));
        let stderr_task = tokio::spawn(read_child_stream(
            child.stderr.take(),
            sender.clone(),
            BashOutputStream::Stderr,
        ));
        drop(sender);

        let mut wait_task = tokio::spawn(async move {
            child
                .wait()
                .await
                .map_err(|error| format!("Could not wait for background process: {error}"))
        });
        let mut wait_result: Option<ExitStatus> = None;
        let mut streams_closed = false;

        while wait_result.is_none() || !streams_closed {
            tokio::select! {
                maybe_chunk = receiver.recv(), if !streams_closed => {
                    match maybe_chunk {
                        Some(chunk) => {
                            let update = match chunk.stream {
                                BashOutputStream::Stdout => {
                                    sqlite_repository::update_process_tails(&process_id, &chunk.text, "")
                                }
                                BashOutputStream::Stderr => {
                                    sqlite_repository::update_process_tails(&process_id, "", &chunk.text)
                                }
                            };

                            if let Ok(process) = update {
                                runtime.emit_process_update(&window, process);
                            }
                        }
                        None => {
                            streams_closed = true;
                        }
                    }
                }
                result = &mut wait_task, if wait_result.is_none() => {
                    wait_result = result.ok().and_then(Result::ok);
                }
            }
        }

        let _ = stdout_task.await;
        let _ = stderr_task.await;

        let status = wait_result;
        let process = match status {
            Some(status) => sqlite_repository::finish_process(
                &process_id,
                if status.success() { "done" } else { "error" },
                status.code().map(i64::from),
            ),
            None => sqlite_repository::finish_process(&process_id, "error", None),
        };

        runtime.unregister_background_process(&process_id);

        if let Ok(process) = process {
            runtime.emit_process_update(&window, process);
        }
    });
}

#[allow(dead_code)]
fn _serialize_process_for_tests(process: WorkspaceProcessPayload) -> Value {
    json!(process)
}

#[cfg(all(test, unix))]
mod tests {
    use std::{process::Stdio, time::Duration};

    use tokio::io::{AsyncBufReadExt, BufReader};

    use super::{build_shell_command, terminate_pid};

    #[tokio::test]
    async fn process_group_termination_stops_shell_descendants() {
        let mut command = build_shell_command("sleep 30 & echo $!; wait");
        command
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("spawn shell command");
        let shell_pid = child.id().expect("shell pid");
        let mut child_pid_line = String::new();
        let mut stdout = BufReader::new(child.stdout.take().expect("shell stdout"));
        tokio::time::timeout(
            Duration::from_secs(2),
            stdout.read_line(&mut child_pid_line),
        )
        .await
        .expect("child pid output timeout")
        .expect("read child pid");
        let descendant_pid = child_pid_line.trim().parse::<u32>().expect("child pid");

        terminate_pid(shell_pid)
            .await
            .expect("terminate process group");
        tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .expect("shell reap timeout")
            .expect("reap shell");

        let mut descendant_alive = true;
        for _ in 0..20 {
            descendant_alive = std::process::Command::new("kill")
                .args(["-0", &descendant_pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            if !descendant_alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(!descendant_alive, "descendant process remained alive");
    }
}
