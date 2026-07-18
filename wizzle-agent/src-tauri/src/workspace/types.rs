use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPreviewPayload {
    pub content: Option<String>,
    pub content_hash: Option<String>,
    pub error: Option<String>,
    pub id: String,
    pub image_src: Option<String>,
    pub is_sensitive: Option<bool>,
    pub kind: String,
    pub language: Option<String>,
    pub mime_type: Option<String>,
    pub name: String,
    pub original_path: Option<String>,
    pub path: String,
    pub preview_metadata: Option<serde_json::Value>,
    pub real_path: Option<String>,
    pub size_bytes: Option<u64>,
    pub summary: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMessagePayload {
    pub assistant_phase: Option<String>,
    pub content: String,
    pub created_at_label: String,
    pub created_at_ms: u64,
    pub duration_ms: Option<u64>,
    pub edited_at_ms: Option<u64>,
    pub id: String,
    pub linked_file_ids: Option<Vec<String>>,
    pub reasoning: Option<String>,
    pub reasoning_replay: Option<serde_json::Value>,
    pub reasoning_duration_ms: Option<u64>,
    pub role: String,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub turn_id: Option<String>,
    pub started_at_ms: Option<u64>,
    pub status: Option<String>,
    pub completed_at_ms: Option<u64>,
    pub parts: Vec<WorkspaceMessageStepPayload>,
    pub tool_calls: Vec<WorkspaceToolCallPayload>,
    pub tool_results: Vec<WorkspaceToolResultPayload>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTurnSummaryPayload {
    pub completed_at_ms: u64,
    pub estimated_tokens_image_capable: u64,
    pub estimated_tokens_text_only: u64,
    pub estimator_version: u32,
    pub message_ids: Vec<String>,
    pub replay_message_count_image_capable: u64,
    pub replay_message_count_text_only: u64,
    pub turn_id: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCompactedContextPayload {
    pub compacted_turn_ids: Vec<String>,
    pub summary: String,
    pub tokens: u64,
    pub updated_at_ms: u64,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionEventPayload {
    pub after_message_count: u64,
    pub created_at_ms: u64,
    pub id: String,
    pub phase: String,
    pub r#type: String,
    pub updated_at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionPayload {
    pub created_at_ms: u64,
    pub id: String,
    pub messages: Vec<WorkspaceMessagePayload>,
    pub messages_loaded: bool,
    pub model_id: Option<String>,
    pub permission_mode: Option<String>,
    pub reasoning_level: Option<String>,
    pub compacted_context: Option<WorkspaceCompactedContextPayload>,
    pub events: Vec<WorkspaceSessionEventPayload>,
    pub replay_turn_summaries: Vec<WorkspaceTurnSummaryPayload>,
    #[serde(default)]
    pub selected_model_uuid: Option<String>,
    #[serde(default)]
    pub system_prompt_hash: Option<String>,
    #[serde(default)]
    pub system_prompt_tokens: Option<u64>,
    #[serde(default)]
    pub tokenizer_kind: Option<String>,
    #[serde(default)]
    pub tool_def_tokens: Option<u64>,
    #[serde(default)]
    pub tool_defs_hash: Option<String>,
    pub title: String,
    pub updated_at_label: String,
    pub updated_at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSessionLoadPayload {
    pub preview_files: Vec<AttachmentPreviewPayload>,
    pub session: WorkspaceSessionPayload,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProjectPayload {
    pub created_at_ms: u64,
    pub id: String,
    pub is_expanded: bool,
    pub name: String,
    pub root_path: String,
    pub sessions: Vec<WorkspaceSessionPayload>,
    pub updated_at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceToolCallPayload {
    pub id: String,
    pub input: Option<String>,
    pub name: String,
    pub status: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceToolResultPayload {
    pub error: Option<String>,
    pub id: String,
    pub output: Option<String>,
    pub status: Option<String>,
    pub tool_call_id: Option<String>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMessageStepPayload {
    pub content: Option<String>,
    pub created_at_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub error: Option<String>,
    pub id: String,
    pub input: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub name: Option<String>,
    pub output: Option<String>,
    pub parent_part_id: Option<String>,
    pub pruned: Option<bool>,
    pub status: Option<String>,
    pub tokens: Option<u64>,
    pub tool_arguments: Option<String>,
    pub tool_call_id: Option<String>,
    pub r#type: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshotPayload {
    pub is_file_panel_open: bool,
    pub is_sidebar_open: bool,
    pub model_id: String,
    pub permission_mode: String,
    pub reasoning_level: String,
    pub preview_files: Vec<AttachmentPreviewPayload>,
    pub projects: Vec<WorkspaceProjectPayload>,
    pub selected_project_id: String,
    pub selected_session_id: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProjectsFile {
    pub projects: Vec<StoredProjectRecord>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProjectRecord {
    pub created_at: u64,
    pub id: String,
    pub is_expanded: bool,
    pub name: String,
    pub root_path: String,
    pub updated_at: u64,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSessionMetadata {
    pub created_at: u64,
    pub id: String,
    pub model_id: Option<String>,
    pub permission_mode: Option<String>,
    /// Compatibility storage slot for a variant id or encoded structured selection.
    #[serde(default)]
    pub reasoning_level: Option<String>,
    pub project_id: String,
    #[serde(default)]
    pub compacted_context: Option<WorkspaceCompactedContextPayload>,
    #[serde(default)]
    pub selected_model_uuid: Option<String>,
    #[serde(default)]
    pub system_prompt_hash: Option<String>,
    #[serde(default)]
    pub system_prompt_tokens: Option<u64>,
    #[serde(default)]
    pub tokenizer_kind: Option<String>,
    #[serde(default)]
    pub tool_def_tokens: Option<u64>,
    #[serde(default)]
    pub tool_defs_hash: Option<String>,
    pub title: String,
    pub updated_at: u64,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessageRecord {
    pub assistant_phase: Option<String>,
    pub content: String,
    pub created_at: u64,
    pub completed_at_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub edited_at_ms: Option<u64>,
    pub id: String,
    pub linked_file_ids: Vec<String>,
    pub reasoning: Option<String>,
    #[serde(default)]
    pub reasoning_replay: Option<serde_json::Value>,
    pub reasoning_duration_ms: Option<u64>,
    pub attachments: Vec<StoredAttachmentRecord>,
    pub role: String,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub turn_id: Option<String>,
    pub started_at_ms: Option<u64>,
    pub status: Option<String>,
    #[serde(default, alias = "steps")]
    pub parts: Vec<StoredMessageStepRecord>,
    pub tool_calls: Vec<StoredToolCallRecord>,
    pub tool_results: Vec<StoredToolResultRecord>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTurnSummaryRecord {
    pub completed_at_ms: u64,
    pub estimated_tokens_image_capable: u64,
    pub estimated_tokens_text_only: u64,
    pub estimator_version: u32,
    pub message_ids: Vec<String>,
    pub replay_message_count_image_capable: u64,
    pub replay_message_count_text_only: u64,
    pub turn_id: String,
}

#[allow(dead_code)]
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessagesFile {
    pub messages: Vec<StoredMessageRecord>,
}

#[allow(dead_code)]
// This legacy JSONL boundary mirrors the on-disk schema; boxing would add churn to every reader
// for a type that is used only during migration and import/export.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StoredSessionHistoryRecord {
    Message { message: StoredMessageRecord },
    TurnSummary { summary: StoredTurnSummaryRecord },
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAttachmentRecord {
    pub content_hash: Option<String>,
    pub id: String,
    pub kind: String,
    pub language: Option<String>,
    pub mime_type: Option<String>,
    pub name: String,
    pub original_path: Option<String>,
    pub preview_metadata: Option<serde_json::Value>,
    pub real_path: Option<String>,
    pub relative_path: String,
    pub size_bytes: Option<u64>,
    pub summary: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredToolCallRecord {
    pub id: String,
    pub input: Option<String>,
    pub name: String,
    pub status: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredToolResultRecord {
    pub error: Option<String>,
    pub id: String,
    pub output: Option<String>,
    pub status: Option<String>,
    pub tool_call_id: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessageStepRecord {
    pub content: Option<String>,
    pub created_at_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub error: Option<String>,
    pub id: String,
    pub input: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub name: Option<String>,
    pub output: Option<String>,
    pub parent_part_id: Option<String>,
    pub pruned: Option<bool>,
    pub status: Option<String>,
    pub tokens: Option<u64>,
    pub tool_call_id: Option<String>,
    pub r#type: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceSettingsInput {
    pub is_file_panel_open: bool,
    pub is_sidebar_open: bool,
    pub model_id: String,
    pub permission_mode: String,
    pub reasoning_level: String,
    pub selected_project_id: Option<String>,
    pub selected_session_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProjectExpandedInput {
    pub is_expanded: bool,
    pub project_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSessionInput {
    pub project_id: String,
    pub session_id: String,
    pub title: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSessionInput {
    pub project_id: String,
    pub session_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadWorkspaceSessionInput {
    pub project_id: String,
    pub session_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadImplementationPlanStateInput {
    pub session_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveImplementationPlanStateInput {
    pub plan_markdown: String,
    pub session_id: String,
    pub state_json: String,
    pub updated_at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImplementationPlanStatePayload {
    pub plan_path: String,
    pub session_id: String,
    pub state_json: String,
    pub updated_at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceComposerStatePayload {
    pub draft_text: String,
    pub queued_messages: Vec<WorkspaceQueuedMessagePayload>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceQueuedMessagePayload {
    pub attachments: Vec<PersistedPreviewFileInput>,
    pub content: String,
    pub created_at_ms: u64,
    pub id: String,
    pub queue_index: u64,
    pub status: String,
    pub updated_at_ms: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadComposerStateInput {
    pub session_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveComposerStateInput {
    pub draft_text: String,
    pub queued_messages: Vec<PersistedQueuedMessageInput>,
    pub session_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedQueuedMessageInput {
    pub attachments: Vec<PersistedPreviewFileInput>,
    pub content: String,
    pub id: String,
    pub status: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistWorkspaceSessionInput {
    pub preview_files: Vec<PersistedPreviewFileInput>,
    pub project_id: String,
    pub selected_project_id: Option<String>,
    pub selected_session_id: Option<String>,
    pub session: PersistedSessionInput,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistSessionMetadataInput {
    pub project_id: String,
    pub selected_project_id: Option<String>,
    pub selected_session_id: Option<String>,
    pub session: PersistedSessionMetadataInput,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSessionMetadataInput {
    pub compacted_context: Option<WorkspaceCompactedContextPayload>,
    pub created_at_ms: u64,
    pub id: String,
    pub model_id: Option<String>,
    pub permission_mode: Option<String>,
    pub reasoning_level: Option<String>,
    pub selected_model_uuid: Option<String>,
    pub system_prompt_hash: Option<String>,
    #[serde(default)]
    pub system_prompt_tokens: Option<u64>,
    pub title: String,
    pub tokenizer_kind: Option<String>,
    pub tool_def_tokens: Option<u64>,
    pub tool_defs_hash: Option<String>,
    pub updated_at_ms: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionTitleInput {
    pub session_id: String,
    pub title: String,
    pub updated_at_ms: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSessionSelectionInput {
    pub permission_mode: Option<String>,
    pub reasoning_level: Option<String>,
    pub project_id: String,
    pub selected_model_uuid: Option<String>,
    pub session_id: String,
    pub tokenizer_kind: Option<String>,
    pub tool_def_tokens: Option<u64>,
    pub tool_defs_hash: Option<String>,
    pub updated_at_ms: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendOrUpdateMessageInput {
    pub message: PersistedMessageInput,
    pub preview_files: Vec<PersistedPreviewFileInput>,
    pub project_id: String,
    pub session_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertTurnSummaryInput {
    pub session_id: String,
    pub summary: PersistedTurnSummaryInput,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeTurnInput {
    pub session_id: String,
    pub status: String,
    pub turn_id: String,
    pub updated_at_ms: u64,
}

/// Keep only these turn ids in SQL; delete all other turns (and cascaded parts) for the session.
/// Used immediately on message edit so crash mid-run cannot resurrect truncated history (#3/#57).
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncateSessionTranscriptInput {
    pub keep_turn_ids: Vec<String>,
    pub session_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSessionInput {
    pub created_at_ms: u64,
    pub id: String,
    pub messages: Vec<PersistedMessageInput>,
    pub model_id: Option<String>,
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub reasoning_level: Option<String>,
    #[serde(default)]
    pub compacted_context: Option<WorkspaceCompactedContextPayload>,
    #[serde(default)]
    pub events: Vec<WorkspaceSessionEventPayload>,
    pub replay_turn_summaries: Option<Vec<PersistedTurnSummaryInput>>,
    #[serde(default)]
    pub selected_model_uuid: Option<String>,
    #[serde(default)]
    pub system_prompt_hash: Option<String>,
    #[serde(default)]
    pub system_prompt_tokens: Option<u64>,
    #[serde(default)]
    pub tokenizer_kind: Option<String>,
    #[serde(default)]
    pub tool_def_tokens: Option<u64>,
    #[serde(default)]
    pub tool_defs_hash: Option<String>,
    pub title: String,
    pub updated_at_ms: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedMessageInput {
    pub assistant_phase: Option<String>,
    pub completed_at_ms: Option<u64>,
    pub content: String,
    pub created_at_ms: u64,
    pub duration_ms: Option<u64>,
    pub edited_at_ms: Option<u64>,
    pub id: String,
    pub linked_file_ids: Option<Vec<String>>,
    pub reasoning: Option<String>,
    #[serde(default)]
    pub reasoning_replay: Option<serde_json::Value>,
    pub reasoning_duration_ms: Option<u64>,
    pub role: String,
    pub started_at_ms: Option<u64>,
    pub status: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub turn_id: Option<String>,
    #[serde(alias = "steps")]
    pub parts: Option<Vec<PersistedMessageStepInput>>,
    pub tool_calls: Option<Vec<PersistedToolCallInput>>,
    pub tool_results: Option<Vec<PersistedToolResultInput>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertSessionEventInput {
    pub event: WorkspaceSessionEventPayload,
    pub session_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedPreviewFileInput {
    pub content: Option<String>,
    #[serde(default)]
    pub content_hash: Option<String>,
    pub id: String,
    pub image_src: Option<String>,
    #[serde(default)]
    pub is_sensitive: Option<bool>,
    pub kind: String,
    pub language: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    pub name: String,
    #[serde(default)]
    pub original_path: Option<String>,
    pub path: String,
    #[serde(default)]
    pub preview_metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub real_path: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    pub summary: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedToolCallInput {
    pub id: String,
    pub input: Option<String>,
    pub name: String,
    pub status: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedToolResultInput {
    pub error: Option<String>,
    pub id: String,
    pub output: Option<String>,
    pub status: Option<String>,
    pub tool_call_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedMessageStepInput {
    pub content: Option<String>,
    pub created_at_ms: Option<u64>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    pub error: Option<String>,
    pub id: String,
    pub input: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
    pub name: Option<String>,
    pub output: Option<String>,
    #[serde(default)]
    pub parent_part_id: Option<String>,
    #[serde(default)]
    pub pruned: Option<bool>,
    pub status: Option<String>,
    #[serde(default)]
    pub tokens: Option<u64>,
    #[serde(default)]
    pub tool_arguments: Option<String>,
    pub tool_call_id: Option<String>,
    pub r#type: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveToolPathCandidatesInput {
    pub candidates: Vec<String>,
    pub cwd: Option<String>,
    pub project_root: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedToolPathCandidatePayload {
    pub error: Option<String>,
    pub expanded_path: Option<String>,
    pub has_unexpanded_variables: bool,
    pub is_inside_project_root: Option<bool>,
    pub is_safe_external: bool,
    pub raw_path: String,
    pub real_path: Option<String>,
    pub resolved_path: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTurnSummaryInput {
    pub completed_at_ms: u64,
    pub estimated_tokens_image_capable: u64,
    pub estimated_tokens_text_only: u64,
    pub estimator_version: u32,
    pub message_ids: Vec<String>,
    pub replay_message_count_image_capable: u64,
    pub replay_message_count_text_only: u64,
    pub turn_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSettingsFile {
    pub is_file_panel_open: bool,
    pub is_sidebar_open: bool,
    pub model_id: String,
    pub permission_mode: String,
    #[serde(default)]
    pub reasoning_level: String,
    pub selected_project_id: Option<String>,
    pub selected_session_id: Option<String>,
}

impl Default for StoredSettingsFile {
    fn default() -> Self {
        Self {
            is_file_panel_open: true,
            is_sidebar_open: true,
            model_id: "wizzle-1-thinking".to_string(),
            permission_mode: "manual-approve".to_string(),
            reasoning_level: String::new(),
            selected_project_id: None,
            selected_session_id: None,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredVersionFile {
    pub schema_version: u32,
}

impl Default for StoredVersionFile {
    fn default() -> Self {
        Self { schema_version: 2 }
    }
}
