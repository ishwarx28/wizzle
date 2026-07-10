mod attachments;
pub(crate) mod paths;
pub(crate) mod sqlite_repository;
mod types;

use std::sync::Mutex;

use tauri::{State, Window};

use crate::agent::AgentRuntimeState;

pub use attachments::{build_attachment_preview_from_bytes, read_attachment_previews};
pub use types::WorkspaceSnapshotPayload;
use types::{
    AppendOrUpdateMessageInput, DeleteSessionInput, FinalizeTurnInput, LoadComposerStateInput,
    LoadWorkspaceSessionInput, PersistSessionMetadataInput, PersistWorkspaceSessionInput,
    RenameSessionInput, SaveComposerStateInput, SaveWorkspaceSettingsInput,
    SetProjectExpandedInput, TruncateSessionTranscriptInput, UpdateSessionSelectionInput,
    UpdateSessionTitleInput, UpsertTurnSummaryInput, WorkspaceComposerStatePayload,
    WorkspaceSessionLoadPayload,
};

pub const MAX_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;

pub struct WorkspaceStorageLock(pub Mutex<()>);

impl Default for WorkspaceStorageLock {
    fn default() -> Self {
        Self(Mutex::new(()))
    }
}

pub fn mark_orphaned_processes_on_startup() -> Result<(), String> {
    sqlite_repository::mark_orphaned_processes_on_startup()
}

#[tauri::command]
pub fn load_workspace_snapshot(
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<WorkspaceSnapshotPayload, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::build_workspace_snapshot()
}

#[tauri::command]
pub fn load_workspace_session(
    input: LoadWorkspaceSessionInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<WorkspaceSessionLoadPayload, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::load_workspace_session(input)
}

#[tauri::command]
pub fn load_composer_state(
    input: LoadComposerStateInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<WorkspaceComposerStatePayload, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::load_composer_state(input)
}

#[tauri::command]
pub fn save_composer_state(
    input: SaveComposerStateInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::save_composer_state(input)
}

#[tauri::command]
pub fn add_project_from_path(
    root_path: String,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<WorkspaceSnapshotPayload, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::add_project_from_path(&root_path)
}

#[tauri::command]
pub fn remove_project_by_id(
    project_id: String,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<WorkspaceSnapshotPayload, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::remove_project_by_id(&project_id)
}

#[tauri::command]
pub fn save_workspace_settings(
    input: SaveWorkspaceSettingsInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::save_workspace_settings(input)
}

#[tauri::command]
pub fn set_project_expanded(
    input: SetProjectExpandedInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::set_project_expanded(input)
}

#[tauri::command]
pub fn rename_workspace_session(
    input: RenameSessionInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<WorkspaceSnapshotPayload, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::rename_session(input)
}

#[tauri::command]
pub async fn delete_workspace_session(
    window: Window,
    input: DeleteSessionInput,
    lock: State<'_, WorkspaceStorageLock>,
    runtime: State<'_, AgentRuntimeState>,
) -> Result<WorkspaceSnapshotPayload, String> {
    runtime
        .prepare_session_delete(&window, &input.session_id)
        .await?;
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::delete_session(input)
}

#[tauri::command]
pub fn persist_workspace_session(
    input: PersistWorkspaceSessionInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::persist_session(input)
}

#[tauri::command]
pub fn create_session_if_needed(
    input: PersistSessionMetadataInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::create_session_if_needed(input)
}

#[tauri::command]
pub fn update_session_title(
    input: UpdateSessionTitleInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::update_session_title(input)
}

#[tauri::command]
pub fn update_session_selection(
    input: UpdateSessionSelectionInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::update_session_selection(input)
}

#[tauri::command]
pub fn append_or_update_message(
    input: AppendOrUpdateMessageInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::append_or_update_message(input)
}

#[tauri::command]
pub fn upsert_turn_summary(
    input: UpsertTurnSummaryInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::upsert_turn_summary(input)
}

#[tauri::command]
pub fn truncate_session_transcript_to_turns(
    input: TruncateSessionTranscriptInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<u32, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::truncate_session_transcript_to_turns(input)
}

#[tauri::command]
pub fn finalize_turn(
    input: FinalizeTurnInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::finalize_turn(input)
}
