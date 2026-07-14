mod context;
mod process_command;
mod runtime;
pub(crate) mod tools;
mod types;

use tauri::State;
use tauri::Window;

use context::load_agent_project_context as load_agent_project_context_impl;
pub use runtime::{
    begin_session_run, finish_session_run, get_session_runtime_state, interrupt_session_run,
    list_agent_processes, list_session_runtime_states, read_agent_process,
    set_session_runtime_state, stop_agent_process, wake_session_run, AgentRuntimeState,
    SessionRuntimeStateKind,
};
use tools::run_agent_tool as run_agent_tool_impl;
use types::{AgentProjectContextPayload, AgentToolRunPayload, RunAgentToolInput};

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
