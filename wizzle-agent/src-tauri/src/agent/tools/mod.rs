mod bash;
mod edit;
mod output;
pub(crate) mod pathing;
mod read;
mod shared;
mod write;

use serde_json::Value;
use tauri::Window;

use crate::agent::AgentRuntimeState;

use super::types::{AgentToolRunPayload, RunAgentToolInput};

pub async fn run_agent_tool(
    window: Window,
    input: RunAgentToolInput,
    runtime: &AgentRuntimeState,
) -> Result<AgentToolRunPayload, String> {
    let project_root = pathing::canonical_project_root(&input.project_id)?;
    let session_id = input
        .session_id
        .as_deref()
        .ok_or_else(|| "A stored session is required to run agent tools.".to_string())?;
    if input
        .tool_call_id
        .as_deref()
        .is_none_or(|value| value.trim().is_empty())
    {
        return Err("A tool call identifier is required to run agent tools.".to_string());
    }

    if !runtime.is_session_run_active(session_id) {
        return Err("Agent tools can only run during an active session turn.".to_string());
    }

    // In-app approval is enforced in the agent runner UI. Backend still verifies the
    // session exists, the run is active, and the permission mode is known.
    let permission_mode = crate::workspace::sqlite_repository::resolve_session_tool_permission(
        session_id,
        &input.project_id,
    )?;
    if !matches!(permission_mode.as_str(), "full-access" | "manual-approve") {
        return Err("The session has an unsupported tool permission mode.".to_string());
    }

    let arguments = serde_json::from_str::<Value>(&input.arguments)
        .map_err(|error| format!("Invalid JSON tool arguments: {error}"))?;

    match input.tool_name.as_str() {
        "read" => read::run(project_root, arguments, input.image_capable).await,
        "write" => {
            let lock_path = write::resolve_lock_path(&project_root, &arguments)?;
            let session_lock = input
                .session_id
                .as_deref()
                .map(|id| runtime.session_write_lock(id))
                .transpose()?;
            let path_lock = runtime.write_path_lock(&lock_path)?;
            let _session_guard = match &session_lock {
                Some(lock) => Some(lock.lock().await),
                None => None,
            };
            let _path_guard = path_lock.lock().await;
            write::run(project_root, arguments).await
        }
        "edit" => {
            let lock_path = edit::resolve_lock_path(&project_root, &arguments)?;
            let session_lock = input
                .session_id
                .as_deref()
                .map(|id| runtime.session_write_lock(id))
                .transpose()?;
            let path_lock = runtime.write_path_lock(&lock_path)?;
            let _session_guard = match &session_lock {
                Some(lock) => Some(lock.lock().await),
                None => None,
            };
            let _path_guard = path_lock.lock().await;
            edit::run(project_root, arguments).await
        }
        "bash" => {
            bash::run(
                project_root,
                arguments,
                input.tool_call_id.as_deref(),
                &window,
                runtime,
                input.session_id.as_deref(),
                input.turn_id.as_deref(),
            )
            .await
        }
        _ => Ok(output::error(format!(
            "The tool {} is not available in Wizzle.",
            input.tool_name
        ))),
    }
}
