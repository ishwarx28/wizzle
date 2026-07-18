mod agent;
mod app_update;
mod image_preview;
mod logging;
mod providers;
mod remote_config;
mod workspace;

use agent::{
    begin_session_run, finish_session_run, get_session_runtime_state, interrupt_session_run,
    list_agent_processes, list_session_runtime_states, load_agent_project_context,
    read_agent_process, run_agent_tool, set_session_runtime_state, stop_agent_process,
    wake_session_run, AgentRuntimeState,
};
use app_update::install_app_update;
use logging::{log_desktop_event, write_frontend_logs};
use providers::{
    cancel_provider_chat, complete_provider_chat, delete_provider, list_provider_models,
    list_providers, refresh_provider_models, stream_provider_chat, upsert_provider,
    ProviderChatRequestStore,
};
use remote_config::{
    load_remote_config, setup_managed_provider, update_managed_provider_api_key, RemoteConfigState,
};
use workspace::{
    add_project_from_path, append_or_update_message, build_attachment_preview_from_bytes,
    check_project_root_exists, create_session_if_needed, delete_workspace_session, finalize_turn,
    load_composer_state, load_implementation_plan_state, load_workspace_session,
    load_workspace_snapshot, mark_orphaned_processes_on_startup, persist_workspace_session,
    read_attachment_previews, remove_project_by_id, rename_workspace_session,
    resolve_tool_path_candidates, save_composer_state, save_implementation_plan_state,
    save_workspace_settings, set_project_expanded, truncate_session_transcript_to_turns,
    update_session_selection, update_session_title, upsert_session_event, upsert_turn_summary,
    WorkspaceStorageLock,
};

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = dotenvy::dotenv();
    log_desktop_event(
        "info",
        "desktop.app",
        "startup",
        serde_json::json!({ "status": "booting" }),
    );
    if let Err(error) = mark_orphaned_processes_on_startup() {
        log_desktop_event(
            "warn",
            "desktop.workspace",
            "process_orphan_cleanup_failed",
            serde_json::json!({ "error": error }),
        );
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(ProviderChatRequestStore::default())
        .manage(RemoteConfigState::default())
        .manage(AgentRuntimeState::default())
        .manage(WorkspaceStorageLock::default())
        .invoke_handler(tauri::generate_handler![
            load_workspace_snapshot,
            load_workspace_session,
            load_composer_state,
            save_composer_state,
            load_implementation_plan_state,
            save_implementation_plan_state,
            add_project_from_path,
            remove_project_by_id,
            check_project_root_exists,
            save_workspace_settings,
            set_project_expanded,
            rename_workspace_session,
            delete_workspace_session,
            persist_workspace_session,
            create_session_if_needed,
            update_session_title,
            update_session_selection,
            append_or_update_message,
            upsert_turn_summary,
            upsert_session_event,
            truncate_session_transcript_to_turns,
            finalize_turn,
            read_attachment_previews,
            build_attachment_preview_from_bytes,
            resolve_tool_path_candidates,
            load_agent_project_context,
            run_agent_tool,
            get_session_runtime_state,
            set_session_runtime_state,
            list_session_runtime_states,
            wake_session_run,
            begin_session_run,
            finish_session_run,
            interrupt_session_run,
            list_agent_processes,
            read_agent_process,
            stop_agent_process,
            write_frontend_logs,
            install_app_update,
            exit_app,
            list_providers,
            upsert_provider,
            delete_provider,
            list_provider_models,
            refresh_provider_models,
            load_remote_config,
            setup_managed_provider,
            update_managed_provider_api_key,
            cancel_provider_chat,
            complete_provider_chat,
            stream_provider_chat
        ])
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
