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
    agent::{
        process_command::hide_tokio_console, runtime::terminate_pid, types::AgentToolRunPayload,
        AgentRuntimeState,
    },
    workspace::sqlite_repository::{self, NewProcessRecord, WorkspaceProcessPayload},
};

const AGENT_TOOL_CHUNK_EVENT: &str = "agent-tool-chunk";
const BACKGROUND_PROCESS_PERSIST_BYTES: usize = 32 * 1024;
const BACKGROUND_PROCESS_PERSIST_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(250);
const MAX_STREAM_CAPTURE_BYTES: usize = MAX_COMMAND_OUTPUT_BYTES / 2;
const PROCESS_CLEANUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Clone, Copy, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ShellAction {
    ListProcesses,
    ReadProcess,
    Run,
    StopProcess,
}

#[derive(Clone, Copy, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum ShellExecutionType {
    Background,
    Foreground,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellToolArguments {
    action: Option<ShellAction>,
    command: Option<String>,
    cwd: Option<String>,
    process_id: Option<String>,
    timeout: Option<ToolTimeout>,
    #[serde(rename = "type")]
    execution_type: ShellExecutionType,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentToolChunkPayload {
    chunk: String,
    stream: ShellOutputStream,
    tool_call_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum ShellOutputStream {
    Stderr,
    Stdout,
}

struct OutputChunk {
    stream: ShellOutputStream,
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

pub(super) struct ShellRunContext<'a> {
    pub allow_external_paths: bool,
    pub runtime: &'a AgentRuntimeState,
    pub session_id: Option<&'a str>,
    pub tool_call_id: Option<&'a str>,
    pub turn_id: Option<&'a str>,
    pub window: &'a Window,
}

pub async fn run(
    project_root: PathBuf,
    arguments: Value,
    context: ShellRunContext<'_>,
) -> Result<AgentToolRunPayload, String> {
    let arguments: ShellToolArguments = serde_json::from_value(arguments)
        .map_err(|error| format!("Invalid arguments for shell: {error}"))?;
    let action = arguments.action.unwrap_or(ShellAction::Run);

    match action {
        ShellAction::Run => run_command(project_root, arguments, &context).await,
        ShellAction::ListProcesses => {
            let session_id = require_session_id(context.session_id)?;
            let processes = sqlite_repository::list_processes(session_id)?;
            Ok(output::success(json!({
                "ok": true,
                "processes": processes,
            })))
        }
        ShellAction::ReadProcess => {
            let session_id = require_session_id(context.session_id)?;
            let process_id = require_process_id(&arguments)?;
            let process = sqlite_repository::read_process(session_id, process_id)?;
            Ok(output::success(json!({
                "ok": true,
                "process": process,
            })))
        }
        ShellAction::StopProcess => {
            let session_id = require_session_id(context.session_id)?;
            let process_id = require_process_id(&arguments)?;
            let process = context
                .runtime
                .stop_process(context.window, session_id, process_id)
                .await?;
            Ok(output::success(json!({
                "ok": true,
                "process": process,
            })))
        }
    }
}

fn require_session_id(session_id: Option<&str>) -> Result<&str, String> {
    session_id.ok_or_else(|| "A stored session is required for shell process actions.".to_string())
}

fn require_process_id(arguments: &ShellToolArguments) -> Result<&str, String> {
    arguments
        .process_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "The shell process action requires processId.".to_string())
}

fn require_command(arguments: &ShellToolArguments) -> Result<String, String> {
    arguments
        .command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "The shell run action requires command.".to_string())
}

fn command_looks_unsafe(command: &str) -> Option<&'static str> {
    let normalized = command.trim().to_ascii_lowercase();

    if normalized.contains("nohup ")
        || normalized.contains(" disown")
        || normalized.contains(" setsid ")
        || normalized.ends_with('&')
    {
        return Some("Use shell type \"background\" instead of shell background syntax.");
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

fn starts_with_command(value: &str, command: &str) -> bool {
    value == command
        || value
            .strip_prefix(command)
            .is_some_and(|rest| rest.starts_with(' '))
}

fn has_argument(value: &str, argument: &str) -> bool {
    value.split_whitespace().any(|word| word == argument)
}

fn is_vite_server_command(value: &str, prefix: &str) -> bool {
    if value == prefix {
        return true;
    }

    let Some(arguments) = value
        .strip_prefix(prefix)
        .and_then(|rest| rest.strip_prefix(' '))
    else {
        return false;
    };
    let first = arguments.split_whitespace().next().unwrap_or_default();

    matches!(first, "dev" | "preview" | "serve")
        || first.starts_with("--host")
        || first.starts_with("--port")
}

/// Conservative classifier for commands with no natural short-lived exit.
/// False negatives fall back to the foreground timeout; avoid false positives
/// because auto-backgrounding a finite command changes ordering semantics.
fn persistent_command_reason(command: &str) -> Option<&'static str> {
    let normalized = command
        .to_ascii_lowercase()
        .replace("&&", "\n")
        .replace("||", "\n")
        .replace(';', "\n");

    for raw_segment in normalized.lines() {
        let segment = raw_segment.split_whitespace().collect::<Vec<_>>().join(" ");
        let segment = segment.trim_matches(|character| matches!(character, '(' | ')' | '{' | '}'));

        if segment.is_empty()
            || starts_with_command(segment, "timeout")
            || has_argument(segment, "--help")
            || has_argument(segment, "--version")
        {
            continue;
        }

        if [
            "npm run dev",
            "npm run preview",
            "npm run serve",
            "npm run watch",
            "pnpm dev",
            "pnpm preview",
            "pnpm run dev",
            "pnpm run preview",
            "pnpm run serve",
            "pnpm run watch",
            "yarn dev",
            "yarn preview",
            "yarn run dev",
            "yarn run preview",
            "yarn run serve",
            "yarn run watch",
            "bun run dev",
            "bun run preview",
            "bun run serve",
            "bun run watch",
        ]
        .iter()
        .any(|prefix| starts_with_command(segment, prefix))
        {
            return Some("Detected a persistent package-script server or watcher.");
        }

        if ["vite", "npx vite", "pnpm exec vite", "bunx vite"]
            .iter()
            .any(|prefix| is_vite_server_command(segment, prefix))
            || [
                "next dev",
                "npx next dev",
                "nuxt dev",
                "npx nuxt dev",
                "astro dev",
                "npx astro dev",
                "webpack serve",
                "webpack-dev-server",
                "parcel serve",
                "nodemon",
                "cargo watch",
                "dotnet watch",
                "flask run",
                "rails server",
                "python -m http.server",
                "python3 -m http.server",
                "php -s",
                "uvicorn",
                "gunicorn",
                "kubectl port-forward",
            ]
            .iter()
            .any(|prefix| starts_with_command(segment, prefix))
        {
            return Some("Detected a persistent development server or watcher.");
        }

        let follows_output = [
            "tail",
            "journalctl",
            "kubectl logs",
            "docker logs",
            "docker compose logs",
            "docker-compose logs",
        ]
        .iter()
        .any(|prefix| starts_with_command(segment, prefix))
            && (has_argument(segment, "-f")
                || has_argument(segment, "-F")
                || has_argument(segment, "--follow"));
        if follows_output {
            return Some("Detected a command that follows output indefinitely.");
        }

        let compose_up = ["docker compose up", "docker-compose up"]
            .iter()
            .any(|prefix| starts_with_command(segment, prefix))
            && !has_argument(segment, "-d")
            && !has_argument(segment, "--detach");
        if compose_up {
            return Some("Detected attached Docker services intended to keep running.");
        }

        let watch_mode = [
            "jest",
            "npm test",
            "pnpm test",
            "yarn test",
            "tsc",
            "webpack",
        ]
        .iter()
        .any(|prefix| starts_with_command(segment, prefix))
            && (has_argument(segment, "--watch") || has_argument(segment, "--watchall"));
        let vitest_watch = starts_with_command(segment, "vitest")
            && !has_argument(segment, "run")
            && !has_argument(segment, "--run");
        if watch_mode || vitest_watch {
            return Some("Detected a test or compiler watch mode.");
        }
    }

    None
}

fn build_shell_command(command: &str) -> Command {
    if cfg!(target_os = "windows") {
        let mut process = Command::new("cmd");
        hide_tokio_console(&mut process);
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

fn resolve_command_cwd(
    project_root: &Path,
    cwd: Option<&str>,
    allow_external_paths: bool,
) -> Result<PathBuf, String> {
    let Some(cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(project_root.to_path_buf());
    };
    let path =
        pathing::resolve_existing_path_with_approval(project_root, cwd, allow_external_paths)?;

    if !path.is_dir() {
        return Err(format!(
            "The shell cwd {} is not a directory.",
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
    output_stream: ShellOutputStream,
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
        ShellOutputStream::Stdout,
    ));
    let stderr_task = tokio::spawn(read_child_stream(
        child.stderr.take(),
        sender.clone(),
        ShellOutputStream::Stderr,
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
                            ShellOutputStream::Stdout => {
                                stdout_truncated |= append_with_limit(
                                    &mut stdout,
                                    &chunk.text,
                                    MAX_STREAM_CAPTURE_BYTES,
                                );
                            }
                            ShellOutputStream::Stderr => {
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
    arguments: ShellToolArguments,
    context: &ShellRunContext<'_>,
) -> Result<AgentToolRunPayload, String> {
    let command = require_command(&arguments)?;

    if let Some(message) = command_looks_unsafe(&command) {
        return Err(message.to_string());
    }

    let cwd = resolve_command_cwd(
        &project_root,
        arguments.cwd.as_deref(),
        context.allow_external_paths,
    )?;

    let persistent_reason = persistent_command_reason(&command);
    let auto_backgrounded =
        arguments.execution_type == ShellExecutionType::Foreground && persistent_reason.is_some();
    if arguments.execution_type == ShellExecutionType::Background || auto_backgrounded {
        let session_id = require_session_id(context.session_id)?;
        let lock = context.runtime.background_process_lock(session_id)?;
        let _guard = lock.lock().await;
        return start_background_process(BackgroundProcessRequest {
            auto_backgrounded,
            background_reason: persistent_reason,
            command_text: command,
            cwd,
            runtime: context.runtime,
            session_id,
            tool_call_id: context.tool_call_id,
            turn_id: context.turn_id,
            window: context.window,
        })
        .await;
    }

    let session_key = context
        .session_id
        .map(str::to_string)
        .unwrap_or_else(|| project_root.to_string_lossy().to_string());
    let lock = context.runtime.foreground_shell_lock(&session_key)?;
    let _guard = lock.lock().await;
    execute_foreground(
        command,
        cwd,
        arguments.timeout.unwrap_or_default(),
        context.tool_call_id,
        context.window,
        context.runtime,
        context.session_id,
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
                error: Some("The shell tool was interrupted.".to_string()),
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
            format!("The shell tool timed out after {}.", timeout.label()),
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

struct BackgroundProcessRequest<'a> {
    auto_backgrounded: bool,
    background_reason: Option<&'a str>,
    command_text: String,
    cwd: PathBuf,
    runtime: &'a AgentRuntimeState,
    session_id: &'a str,
    tool_call_id: Option<&'a str>,
    turn_id: Option<&'a str>,
    window: &'a Window,
}

async fn start_background_process(
    request: BackgroundProcessRequest<'_>,
) -> Result<AgentToolRunPayload, String> {
    let BackgroundProcessRequest {
        auto_backgrounded,
        background_reason,
        command_text,
        cwd,
        runtime,
        session_id,
        tool_call_id,
        turn_id,
        window,
    } = request;
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
        "autoBackgrounded": auto_backgrounded,
        "backgroundReason": background_reason,
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
            ShellOutputStream::Stdout,
        ));
        let stderr_task = tokio::spawn(read_child_stream(
            child.stderr.take(),
            sender.clone(),
            ShellOutputStream::Stderr,
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
        let mut pending_stdout = String::new();
        let mut pending_stderr = String::new();
        let mut persist_interval = tokio::time::interval(BACKGROUND_PROCESS_PERSIST_INTERVAL);
        persist_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // `interval` ticks immediately once; consume it so the first write is coalesced.
        persist_interval.tick().await;

        while wait_result.is_none() || !streams_closed {
            tokio::select! {
                maybe_chunk = receiver.recv(), if !streams_closed => {
                    match maybe_chunk {
                        Some(chunk) => {
                            match chunk.stream {
                                ShellOutputStream::Stdout => {
                                    pending_stdout.push_str(&chunk.text);
                                }
                                ShellOutputStream::Stderr => {
                                    pending_stderr.push_str(&chunk.text);
                                }
                            }

                            if pending_stdout.len().saturating_add(pending_stderr.len())
                                >= BACKGROUND_PROCESS_PERSIST_BYTES
                            {
                                flush_background_process_output(
                                    &process_id,
                                    &mut pending_stdout,
                                    &mut pending_stderr,
                                    &window,
                                    &runtime,
                                );
                            }
                        }
                        None => {
                            streams_closed = true;
                        }
                    }
                }
                _ = persist_interval.tick(), if !pending_stdout.is_empty() || !pending_stderr.is_empty() => {
                    flush_background_process_output(
                        &process_id,
                        &mut pending_stdout,
                        &mut pending_stderr,
                        &window,
                        &runtime,
                    );
                }
                result = &mut wait_task, if wait_result.is_none() => {
                    wait_result = result.ok().and_then(Result::ok);
                }
            }
        }

        let _ = stdout_task.await;
        let _ = stderr_task.await;
        flush_background_process_output(
            &process_id,
            &mut pending_stdout,
            &mut pending_stderr,
            &window,
            &runtime,
        );

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

fn flush_background_process_output(
    process_id: &str,
    pending_stdout: &mut String,
    pending_stderr: &mut String,
    window: &Window,
    runtime: &AgentRuntimeState,
) {
    if pending_stdout.is_empty() && pending_stderr.is_empty() {
        return;
    }

    let Ok(process) =
        sqlite_repository::update_process_tails(process_id, pending_stdout, pending_stderr)
    else {
        return;
    };

    pending_stdout.clear();
    pending_stderr.clear();
    runtime.emit_process_update(window, process);
}

#[allow(dead_code)]
fn _serialize_process_for_tests(process: WorkspaceProcessPayload) -> Value {
    json!(process)
}

#[cfg(test)]
mod safety_tests {
    use super::{command_looks_unsafe, persistent_command_reason, ShellToolArguments};

    #[test]
    fn blocks_catastrophic_commands_but_allows_project_relative_deletion() {
        for command in [
            "sudo rm -rf ./build",
            "shutdown /s /t 0",
            "reboot",
            "mkfs.ext4 /dev/sda",
            "dd if=/dev/zero of=/dev/sda",
            "diskutil eraseDisk APFS Empty /dev/disk2",
            "rm -rf /",
            "rm -rf ~",
            ":(){ :|:& };:",
        ] {
            assert!(
                command_looks_unsafe(command).is_some(),
                "expected catastrophic command to be blocked: {command}",
            );
        }

        for command in ["rm -rf .", "rm -rf ./build", "rm -f src/generated.ts"] {
            assert!(
                command_looks_unsafe(command).is_none(),
                "expected project-relative deletion to be allowed: {command}",
            );
        }
    }

    #[test]
    fn shell_execution_type_is_required() {
        assert!(
            serde_json::from_value::<ShellToolArguments>(serde_json::json!({
                "action": "run",
                "command": "git status"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ShellToolArguments>(serde_json::json!({
                "action": "run",
                "command": "git status",
                "type": "foreground"
            }))
            .is_ok()
        );
    }

    #[test]
    fn detects_only_high_confidence_persistent_commands() {
        for command in [
            "npm run dev",
            "cd web && vite --host 0.0.0.0",
            "python3 -m http.server 8000",
            "tail -f server.log",
            "docker compose up",
            "npm test -- --watch",
            "kubectl port-forward service/api 8080:80",
        ] {
            assert!(
                persistent_command_reason(command).is_some(),
                "expected persistent command: {command}",
            );
        }

        for command in [
            "npm run build",
            "vite build",
            "tail -n 20 server.log",
            "docker compose up -d",
            "vitest run",
            "rg 'npm run dev' src",
            "timeout 5 npm run dev",
        ] {
            assert!(
                persistent_command_reason(command).is_none(),
                "expected finite command: {command}",
            );
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{
        process::{Command, Stdio},
        time::Duration,
    };

    use tokio::io::{AsyncBufReadExt, BufReader};

    use super::{build_shell_command, terminate_pid};

    fn process_is_alive(pid: u32) -> bool {
        let output = Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();
        let Ok(output) = output else {
            return false;
        };
        if !output.status.success() {
            return false;
        }

        let state = String::from_utf8_lossy(&output.stdout);
        let state = state.trim();
        !state.is_empty() && !state.starts_with('Z')
    }

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
        // Linux runners may report a killed child as a zombie briefly after the shell exits.
        for _ in 0..100 {
            descendant_alive = process_is_alive(descendant_pid);
            if !descendant_alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(!descendant_alive, "descendant process remained alive");
    }
}
