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
            )
            .await
        }
        _ => Ok(output::error(format!(
            "The tool {} is not available in Wizzle.",
            input.tool_name
        ))),
    }
}
