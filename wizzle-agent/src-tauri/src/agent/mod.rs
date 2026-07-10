mod context;
mod runtime;
pub(crate) mod tools;
mod types;

use tauri::State;
use tauri::Window;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use context::load_agent_project_context as load_agent_project_context_impl;
pub use runtime::{
    begin_session_run, finish_session_run, get_session_runtime_state, interrupt_session_run,
    list_agent_processes, list_session_runtime_states, read_agent_process,
    set_session_runtime_state, stop_agent_process, wake_session_run, AgentRuntimeState,
    SessionRuntimeStateKind,
};
use tools::run_agent_tool as run_agent_tool_impl;
use types::{
    AgentProjectContextPayload, AgentToolApprovalPayload, AgentToolRunPayload,
    RequestAgentToolApprovalInput, RunAgentToolInput,
};

#[tauri::command]
pub fn load_agent_project_context(
    project_id: String,
    session_id: Option<String>,
) -> Result<AgentProjectContextPayload, String> {
    load_agent_project_context_impl(project_id, session_id)
}

#[tauri::command]
pub async fn run_agent_tool(
    window: Window,
    input: RunAgentToolInput,
    runtime: State<'_, AgentRuntimeState>,
) -> Result<AgentToolRunPayload, String> {
    run_agent_tool_impl(window, input, &runtime).await
}

fn approval_dialog_message(input: &RequestAgentToolApprovalInput) -> String {
    let arguments = serde_json::from_str::<serde_json::Value>(&input.arguments).ok();
    let detail = if input.tool_name == "bash" {
        arguments
            .as_ref()
            .and_then(|value| value.get("command"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Manage a shell process")
    } else {
        arguments
            .as_ref()
            .and_then(|value| value.get("path"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("No path supplied")
    };
    let mut detail = detail.to_string();
    if detail.chars().count() > 1_000 {
        detail = detail.chars().take(1_000).collect::<String>() + "…";
    }

    format!(
        "Allow Wizzle to run the {} tool?\n\n{}\n\nThis native confirmation prevents web content from silently invoking privileged tools.",
        input.tool_name, detail
    )
}

#[tauri::command]
pub async fn request_agent_tool_approval(
    window: Window,
    input: RequestAgentToolApprovalInput,
    runtime: State<'_, AgentRuntimeState>,
) -> Result<AgentToolApprovalPayload, String> {
    if !matches!(input.tool_name.as_str(), "bash" | "edit" | "read" | "write") {
        return Err("That tool cannot be approved.".to_string());
    }
    if input.tool_call_id.trim().is_empty() {
        return Err("The tool approval is missing its call identifier.".to_string());
    }
    if !runtime.is_session_run_active(&input.session_id) {
        return Err("Tool approvals are only available during an active agent run.".to_string());
    }
    crate::workspace::sqlite_repository::resolve_session_tool_permission(
        &input.session_id,
        &input.project_id,
    )?;

    let message = approval_dialog_message(&input);
    let approval_window = window.clone();
    let approved = tokio::task::spawn_blocking(move || {
        approval_window
            .dialog()
            .message(message)
            .title("Approve Wizzle tool")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Allow".to_string(),
                "Deny".to_string(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|error| format!("Could not show the native tool approval: {error}"))?;

    let token = if approved {
        Some(runtime.grant_tool_approval(
            &input.arguments,
            &input.project_id,
            &input.session_id,
            &input.tool_call_id,
            &input.tool_name,
        )?)
    } else {
        None
    };

    Ok(AgentToolApprovalPayload { approved, token })
}
