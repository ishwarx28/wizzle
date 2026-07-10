use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::logging::log_desktop_event;

use super::{
    MAX_ATTACHMENT_BYTES,
    paths::{
        ensure_dir, ensure_workspace_storage, legacy_projects_path, legacy_sessions_dir,
        legacy_session_messages_path, legacy_settings_path, project_dir, project_metadata_path,
        project_sessions_dir, projects_index_path, read_json_or_default, session_attachments_dir,
        session_dir, session_messages_path, session_metadata_path, settings_path,
        validate_storage_id, version_path, write_json, CURRENT_SCHEMA_VERSION,
    },
    types::{
        AttachmentPreviewPayload, DeleteSessionInput, PersistWorkspaceSessionInput,
        PersistedMessageInput, PersistedPreviewFileInput, PersistedToolCallInput,
        PersistedToolResultInput, PersistedTurnSummaryInput, RenameSessionInput,
        SaveWorkspaceSettingsInput, SetProjectExpandedInput, StoredAttachmentRecord,
        StoredMessageRecord, StoredMessageStepRecord, StoredMessagesFile, StoredProjectRecord,
        StoredProjectsFile, StoredSessionHistoryRecord, StoredSessionMetadata, StoredSettingsFile,
        StoredToolCallRecord, StoredToolResultRecord, StoredTurnSummaryRecord, StoredVersionFile,
        WorkspaceMessagePayload, WorkspaceMessageStepPayload, WorkspaceProjectPayload,
        WorkspaceSessionLoadPayload, WorkspaceSessionPayload, WorkspaceSnapshotPayload,
        WorkspaceToolCallPayload, WorkspaceToolResultPayload, WorkspaceTurnSummaryPayload,
    },
};

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn compact_time_label(timestamp_ms: u64) -> String {
    let now = now_unix_ms();
    let delta_ms = now.saturating_sub(timestamp_ms);
    let delta_minutes = delta_ms / 60_000;

    if delta_minutes == 0 {
        return "now".to_string();
    }

    if delta_minutes < 60 {
        return format!("{delta_minutes}m");
    }

    let delta_hours = delta_minutes / 60;
    if delta_hours < 24 {
        return format!("{delta_hours}h");
    }

    let delta_days = delta_hours / 24;
    if delta_days < 7 {
        return format!("{delta_days}d");
    }

    let delta_weeks = delta_days / 7;
    if delta_weeks < 5 {
        return format!("{delta_weeks}w");
    }

    let delta_months = delta_days / 30;
    if delta_months < 12 {
        return format!("{delta_months}mo");
    }

    format!("{}y", delta_days / 365)
}

fn canonical_display_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn sanitize_file_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect::<String>()
        .trim()
        .to_string();

    if sanitized.is_empty() {
        "attachment".to_string()
    } else {
        sanitized
    }
}

fn mime_type_from_extension(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();

    let mime_type = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "md" | "mdx" | "markdown" => "text/markdown",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        "txt" => "text/plain",
        _ => "text/plain",
    };

    Some(mime_type.to_string())
}

fn decode_data_url(data_url: &str) -> Result<(Vec<u8>, Option<String>), String> {
    let Some((metadata, encoded_data)) = data_url.split_once(',') else {
        return Err("Could not decode a pasted attachment.".to_string());
    };

    let mime_type = metadata
        .strip_prefix("data:")
        .and_then(|value| value.split(';').next())
        .map(str::to_string);
    let bytes = STANDARD
        .decode(encoded_data)
        .map_err(|error| format!("Could not decode a pasted attachment: {error}"))?;

    Ok((bytes, mime_type))
}

fn to_workspace_tool_call(record: StoredToolCallRecord) -> WorkspaceToolCallPayload {
    WorkspaceToolCallPayload {
        id: record.id,
        input: record.input,
        name: record.name,
        status: record.status,
    }
}

fn to_workspace_tool_result(record: StoredToolResultRecord) -> WorkspaceToolResultPayload {
    WorkspaceToolResultPayload {
        error: record.error,
        id: record.id,
        output: record.output,
        status: record.status,
        tool_call_id: record.tool_call_id,
    }
}

fn to_workspace_step(record: StoredMessageStepRecord) -> WorkspaceMessageStepPayload {
    WorkspaceMessageStepPayload {
        content: record.content,
        created_at_ms: record.created_at_ms,
        error: record.error,
        id: record.id,
        input: record.input,
        name: record.name,
        output: record.output,
        status: record.status,
        tool_call_id: record.tool_call_id,
        r#type: record.r#type,
    }
}

fn to_workspace_turn_summary(record: StoredTurnSummaryRecord) -> WorkspaceTurnSummaryPayload {
    WorkspaceTurnSummaryPayload {
        completed_at_ms: record.completed_at_ms,
        estimated_tokens_image_capable: record.estimated_tokens_image_capable,
        estimated_tokens_text_only: record.estimated_tokens_text_only,
        estimator_version: record.estimator_version,
        message_ids: record.message_ids,
        replay_message_count_image_capable: record.replay_message_count_image_capable,
        replay_message_count_text_only: record.replay_message_count_text_only,
        turn_id: record.turn_id,
    }
}

struct LoadedSessionHistory {
    messages: Vec<StoredMessageRecord>,
    turn_summaries: Vec<StoredTurnSummaryRecord>,
}

fn read_session_history_records(path: &Path) -> Result<Vec<StoredSessionHistoryRecord>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = fs::read_to_string(path).map_err(|error| {
        format!(
            "Could not read Wizzle data from {}: {error}",
            path.display()
        )
    })?;
    let lines = contents
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some((index, trimmed))
            }
        })
        .collect::<Vec<_>>();
    let last_non_empty_line_index = lines.last().map(|(index, _)| *index);
    let mut records = Vec::new();

    for (index, line) in lines {
        match serde_json::from_str::<StoredSessionHistoryRecord>(line) {
            Ok(record) => records.push(record),
            Err(error) => {
                if Some(index) == last_non_empty_line_index {
                    break;
                }

                return Err(format!(
                    "Could not parse Wizzle history from {}: {error}",
                    path.display()
                ));
            }
        }
    }

    Ok(records)
}

fn write_session_history_records(
    path: &Path,
    records: &[StoredSessionHistoryRecord],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }

    let mut contents = String::new();

    for record in records {
        let line = serde_json::to_string(record).map_err(|error| {
            format!(
                "Could not serialize Wizzle history for {}: {error}",
                path.display()
            )
        })?;
        contents.push_str(&line);
        contents.push('\n');
    }

    let temporary_path = path.with_extension("jsonl.tmp");
    fs::write(&temporary_path, contents).map_err(|error| {
        format!(
            "Could not write temporary Wizzle history to {}: {error}",
            temporary_path.display()
        )
    })?;

    fs::rename(&temporary_path, path).map_err(|error| {
        format!(
            "Could not finalize Wizzle history at {}: {error}",
            path.display()
        )
    })
}

fn load_session_history(
    root: &Path,
    project_id: &str,
    session_id: &str,
) -> Result<LoadedSessionHistory, String> {
    let jsonl_path = session_messages_path(root, project_id, session_id)?;

    if jsonl_path.exists() {
        let records = read_session_history_records(&jsonl_path)?;
        let mut messages = Vec::new();
        let mut turn_summaries = Vec::new();

        for record in records {
            match record {
                StoredSessionHistoryRecord::Message { message } => messages.push(message),
                StoredSessionHistoryRecord::TurnSummary { summary } => turn_summaries.push(summary),
            }
        }

        return Ok(LoadedSessionHistory {
            messages,
            turn_summaries,
        });
    }

    let legacy_path = legacy_session_messages_path(root, project_id, session_id)?;
    let legacy_messages: StoredMessagesFile = read_json_or_default(&legacy_path)?;

    Ok(LoadedSessionHistory {
        messages: legacy_messages.messages,
        turn_summaries: Vec::new(),
    })
}

fn derive_legacy_steps(record: &StoredMessageRecord) -> Vec<StoredMessageStepRecord> {
    let mut steps = Vec::new();

    if let Some(reasoning) = record
        .reasoning
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        steps.push(StoredMessageStepRecord {
            content: Some(reasoning.clone()),
            created_at_ms: record.started_at_ms.or(Some(record.created_at)),
            id: format!("{}-reasoning", record.id),
            status: record.status.clone(),
            r#type: "reasoning".to_string(),
            ..StoredMessageStepRecord::default()
        });
    }

    for tool_call in &record.tool_calls {
        steps.push(StoredMessageStepRecord {
            created_at_ms: record.started_at_ms.or(Some(record.created_at)),
            id: format!("{}-tool-call-{}", record.id, tool_call.id),
            input: tool_call.input.clone(),
            name: Some(tool_call.name.clone()),
            status: tool_call.status.clone(),
            tool_call_id: Some(tool_call.id.clone()),
            r#type: "tool_call".to_string(),
            ..StoredMessageStepRecord::default()
        });

        for tool_result in record
            .tool_results
            .iter()
            .filter(|entry| entry.tool_call_id.as_deref() == Some(tool_call.id.as_str()))
        {
            steps.push(StoredMessageStepRecord {
                created_at_ms: record.started_at_ms.or(Some(record.created_at)),
                error: tool_result.error.clone(),
                id: tool_result.id.clone(),
                output: tool_result.output.clone(),
                status: tool_result.status.clone(),
                tool_call_id: tool_result
                    .tool_call_id
                    .clone()
                    .or(Some(tool_call.id.clone())),
                r#type: "tool_result".to_string(),
                ..StoredMessageStepRecord::default()
            });
        }
    }

    for tool_result in record.tool_results.iter().filter(|entry| {
        let Some(tool_call_id) = entry.tool_call_id.as_deref() else {
            return true;
        };

        !record
            .tool_calls
            .iter()
            .any(|tool_call| tool_call.id == tool_call_id)
    }) {
        steps.push(StoredMessageStepRecord {
            created_at_ms: record.started_at_ms.or(Some(record.created_at)),
            error: tool_result.error.clone(),
            id: tool_result.id.clone(),
            output: tool_result.output.clone(),
            status: tool_result.status.clone(),
            tool_call_id: tool_result.tool_call_id.clone(),
            r#type: "tool_result".to_string(),
            ..StoredMessageStepRecord::default()
        });
    }

    if !record.content.trim().is_empty() {
        steps.push(StoredMessageStepRecord {
            content: Some(record.content.clone()),
            created_at_ms: record.completed_at_ms.or(Some(record.created_at)),
            id: format!("{}-content", record.id),
            status: record.status.clone(),
            r#type: "content".to_string(),
            ..StoredMessageStepRecord::default()
        });
    }

    steps
}

fn load_attachment_preview(
    attachments_root: &Path,
    record: &StoredAttachmentRecord,
) -> Result<AttachmentPreviewPayload, String> {
    let absolute_path = if record.relative_path.is_empty() {
        record
            .original_path
            .as_ref()
            .map(PathBuf::from)
            .ok_or_else(|| "Could not resolve the attachment source path.".to_string())?
    } else {
        attachments_root.join(&record.relative_path)
    };

    let mut payload = AttachmentPreviewPayload {
        content: None,
        error: None,
        id: record.id.clone(),
        image_src: None,
        kind: record.kind.clone(),
        language: record.language.clone(),
        name: record.name.clone(),
        path: absolute_path.to_string_lossy().to_string(),
        summary: record.summary.clone(),
        ..AttachmentPreviewPayload::default()
    };

    match record.kind.as_str() {
        "image" => {
            let bytes = fs::read(&absolute_path).map_err(|error| {
                format!(
                    "Could not read attachment {}: {error}",
                    absolute_path.display()
                )
            })?;
            let mime_type = record
                .mime_type
                .clone()
                .or_else(|| mime_type_from_extension(&absolute_path))
                .unwrap_or_else(|| "image/png".to_string());

            payload.image_src = Some(format!(
                "data:{mime_type};base64,{}",
                STANDARD.encode(bytes)
            ));
        }
        _ => {
            payload.content = Some(fs::read_to_string(&absolute_path).map_err(|error| {
                format!(
                    "Could not read attachment {}: {error}",
                    absolute_path.display()
                )
            })?);
        }
    }

    Ok(payload)
}

fn is_incomplete_lifecycle_status(status: Option<&str>) -> bool {
    matches!(status, Some("streaming" | "pending" | "running"))
}

/// Crash/reload recovery (#8 / #68): unfinished work becomes `interrupted`, never `done`.
/// Kept in sync with `sqlite_repository::recover_incomplete_message`.
fn normalize_message_record(record: StoredMessageRecord) -> StoredMessageRecord {
    let message_incomplete = is_incomplete_lifecycle_status(record.status.as_deref());
    let has_incomplete_parts = record
        .parts
        .iter()
        .any(|part| is_incomplete_lifecycle_status(part.status.as_deref()));
    let has_incomplete_tool_calls = record
        .tool_calls
        .iter()
        .any(|tool_call| is_incomplete_lifecycle_status(tool_call.status.as_deref()));
    let has_incomplete_tool_results = record
        .tool_results
        .iter()
        .any(|tool_result| is_incomplete_lifecycle_status(tool_result.status.as_deref()));

    if !message_incomplete
        && !has_incomplete_parts
        && !has_incomplete_tool_calls
        && !has_incomplete_tool_results
    {
        if record.role == "user"
            && matches!(record.status.as_deref(), Some("interrupted" | "error"))
        {
            let mut record = record;
            record.status = Some("done".to_string());
            return record;
        }
        return record;
    }

    let mut record = record;

    if record.role == "user" {
        record.status = Some("done".to_string());
        for part in &mut record.parts {
            if is_incomplete_lifecycle_status(part.status.as_deref()) || part.status.is_none() {
                part.status = Some("done".to_string());
            }
        }
        if record.completed_at_ms.is_none() {
            record.completed_at_ms = Some(record.created_at);
        }
        return record;
    }

    let has_visible_content = !record.content.trim().is_empty()
        || record
            .reasoning
            .as_ref()
            .is_some_and(|value| !value.trim().is_empty())
        || record.parts.iter().any(|part| {
            matches!(part.r#type.as_str(), "content" | "activity_content")
                && part
                    .content
                    .as_ref()
                    .is_some_and(|value| !value.trim().is_empty())
        });

    if record.role == "assistant" && !has_visible_content {
        record.content = "Response interrupted.".to_string();
    }

    record.status = Some("interrupted".to_string());
    if record.completed_at_ms.is_none() {
        record.completed_at_ms = Some(record.created_at);
    }

    for part in &mut record.parts {
        if is_incomplete_lifecycle_status(part.status.as_deref())
            || (message_incomplete && part.status.is_none())
        {
            if part.status.as_deref() != Some("error") {
                part.status = Some("interrupted".to_string());
            }
        }
    }

    for tool_call in &mut record.tool_calls {
        if is_incomplete_lifecycle_status(tool_call.status.as_deref())
            || (message_incomplete && tool_call.status.is_none())
        {
            if tool_call.status.as_deref() != Some("error") {
                tool_call.status = Some("interrupted".to_string());
            }
        }
    }

    for tool_result in &mut record.tool_results {
        if is_incomplete_lifecycle_status(tool_result.status.as_deref())
            && tool_result.status.as_deref() != Some("error")
        {
            tool_result.status = Some("interrupted".to_string());
        }
    }

    record
}

fn to_workspace_message(
    attachments_root: &Path,
    preview_files: &mut BTreeMap<String, AttachmentPreviewPayload>,
    record: StoredMessageRecord,
) -> Result<WorkspaceMessagePayload, String> {
    let normalized_record = normalize_message_record(record);
    let parts = if normalized_record.parts.is_empty() {
        derive_legacy_steps(&normalized_record)
    } else {
        normalized_record.parts.clone()
    };

    for attachment in &normalized_record.attachments {
        preview_files
            .entry(attachment.id.clone())
            .or_insert(load_attachment_preview(attachments_root, attachment)?);
    }

    Ok(WorkspaceMessagePayload {
        assistant_phase: normalized_record.assistant_phase,
        content: normalized_record.content,
        created_at_label: compact_time_label(normalized_record.created_at),
        created_at_ms: normalized_record.created_at,
        duration_ms: normalized_record.duration_ms,
        edited_at_ms: normalized_record.edited_at_ms,
        id: normalized_record.id,
        linked_file_ids: if normalized_record.linked_file_ids.is_empty() {
            None
        } else {
            Some(normalized_record.linked_file_ids)
        },
        reasoning: normalized_record.reasoning,
        reasoning_duration_ms: normalized_record.reasoning_duration_ms,
        role: normalized_record.role,
        tool_call_id: normalized_record.tool_call_id,
        tool_name: normalized_record.tool_name,
        turn_id: normalized_record.turn_id,
        started_at_ms: normalized_record.started_at_ms,
        status: normalized_record.status,
        completed_at_ms: normalized_record.completed_at_ms,
        parts: parts.into_iter().map(to_workspace_step).collect(),
        tool_calls: normalized_record
            .tool_calls
            .into_iter()
            .map(to_workspace_tool_call)
            .collect(),
        tool_results: normalized_record
            .tool_results
            .into_iter()
            .map(to_workspace_tool_result)
            .collect(),
    })
}

fn migrate_legacy_storage(root: &Path) -> Result<(), String> {
    let current_version: StoredVersionFile = read_json_or_default(&version_path(root))?;
    if current_version.schema_version >= CURRENT_SCHEMA_VERSION {
        return Ok(());
    }

    let legacy_projects_path = legacy_projects_path(root);
    let legacy_settings_path = legacy_settings_path(root);
    let legacy_sessions_dir = legacy_sessions_dir(root);

    if legacy_projects_path.exists() {
        let projects_file: StoredProjectsFile = read_json_or_default(&legacy_projects_path)?;
        write_json(&projects_index_path(root), &projects_file)?;

        for project in &projects_file.projects {
            ensure_dir(&project_dir(root, &project.id)?)?;
            ensure_dir(&project_sessions_dir(root, &project.id)?)?;
            write_json(&project_metadata_path(root, &project.id)?, project)?;
        }
    }

    if legacy_settings_path.exists() {
        let settings: StoredSettingsFile = read_json_or_default(&legacy_settings_path)?;
        write_json(&settings_path(root), &settings)?;
    }

    if legacy_sessions_dir.exists() {
        for project_entry in fs::read_dir(&legacy_sessions_dir)
            .map_err(|error| format!("Could not inspect legacy Wizzle storage: {error}"))?
        {
            let project_entry = project_entry
                .map_err(|error| format!("Could not inspect a legacy Wizzle project: {error}"))?;
            let project_id = project_entry.file_name().to_string_lossy().to_string();
            let project_sessions_dir_path = project_entry.path();

            if !project_sessions_dir_path.is_dir() {
                continue;
            }

            for session_entry in fs::read_dir(&project_sessions_dir_path).map_err(|error| {
                format!("Could not inspect legacy Wizzle sessions for {project_id}: {error}")
            })? {
                let session_entry = session_entry.map_err(|error| {
                    format!("Could not inspect a legacy Wizzle session: {error}")
                })?;
                let session_path = session_entry.path();

                if session_path.extension().and_then(|value| value.to_str()) != Some("json") {
                    continue;
                }

                #[derive(Default, serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct LegacySessionRecord {
                    created_at: u64,
                    id: String,
                    messages: Vec<LegacyMessageRecord>,
                    project_id: String,
                    title: String,
                    updated_at: u64,
                }

                #[derive(serde::Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct LegacyMessageRecord {
                    content: String,
                    created_at: u64,
                    id: String,
                    linked_file_ids: Option<Vec<String>>,
                    role: String,
                }

                let legacy_record: LegacySessionRecord = read_json_or_default(&session_path)?;
                let metadata = StoredSessionMetadata {
                    created_at: legacy_record.created_at,
                    id: legacy_record.id.clone(),
                    model_id: None,
                    permission_mode: None,
                    project_id: legacy_record.project_id.clone(),
                    selected_model_uuid: None,
                    system_prompt_hash: None,
                    tokenizer_kind: None,
                    tool_defs_hash: None,
                    title: legacy_record.title,
                    updated_at: legacy_record.updated_at,
                };
                validate_storage_id("project", &project_id)?;
                validate_storage_id("session", &metadata.id)?;
                let history_records = legacy_record
                    .messages
                    .into_iter()
                    .map(|message| StoredSessionHistoryRecord::Message {
                        message: StoredMessageRecord {
                            assistant_phase: None,
                            completed_at_ms: None,
                            content: message.content,
                            created_at: message.created_at,
                            duration_ms: None,
                            edited_at_ms: None,
                            id: message.id,
                            linked_file_ids: message.linked_file_ids.unwrap_or_default(),
                            reasoning: None,
                            reasoning_duration_ms: None,
                            attachments: Vec::new(),
                            role: message.role,
                            tool_call_id: None,
                            tool_name: None,
                            turn_id: None,
                            started_at_ms: None,
                            status: Some("done".to_string()),
                            parts: Vec::new(),
                            tool_calls: Vec::new(),
                            tool_results: Vec::new(),
                        },
                    })
                    .collect::<Vec<_>>();

                ensure_dir(&session_dir(root, &project_id, &metadata.id)?)?;
                write_json(
                    &session_metadata_path(root, &project_id, &metadata.id)?,
                    &metadata,
                )?;
                write_session_history_records(
                    &session_messages_path(root, &project_id, &metadata.id)?,
                    &history_records,
                )?;
                ensure_dir(&session_attachments_dir(root, &project_id, &metadata.id)?)?;
            }
        }
    }

    write_json(
        &version_path(root),
        &StoredVersionFile {
            schema_version: CURRENT_SCHEMA_VERSION,
        },
    )?;

    if legacy_projects_path.exists() {
        fs::remove_file(&legacy_projects_path).map_err(|error| {
            format!(
                "Could not clean up legacy Wizzle data {}: {error}",
                legacy_projects_path.display()
            )
        })?;
    }

    if legacy_settings_path.exists() {
        fs::remove_file(&legacy_settings_path).map_err(|error| {
            format!(
                "Could not clean up legacy Wizzle data {}: {error}",
                legacy_settings_path.display()
            )
        })?;
    }

    if legacy_sessions_dir.exists() {
        fs::remove_dir_all(&legacy_sessions_dir).map_err(|error| {
            format!(
                "Could not clean up legacy Wizzle data {}: {error}",
                legacy_sessions_dir.display()
            )
        })?;
    }

    Ok(())
}

fn build_workspace_session_summary(metadata: StoredSessionMetadata) -> WorkspaceSessionPayload {
    WorkspaceSessionPayload {
        created_at_ms: metadata.created_at,
        id: metadata.id,
        messages: Vec::new(),
        messages_loaded: false,
        model_id: metadata.model_id,
        permission_mode: metadata.permission_mode,
        compacted_context: metadata.compacted_context,
        events: Vec::new(),
        replay_turn_summaries: Vec::new(),
        selected_model_uuid: metadata.selected_model_uuid,
        system_prompt_hash: metadata.system_prompt_hash,
        tokenizer_kind: metadata.tokenizer_kind,
        tool_defs_hash: metadata.tool_defs_hash,
        title: metadata.title,
        updated_at_label: compact_time_label(metadata.updated_at),
        updated_at_ms: metadata.updated_at,
    }
}

fn load_workspace_session_payload(
    root: &Path,
    project_id: &str,
    session_id: &str,
    preview_files: &mut BTreeMap<String, AttachmentPreviewPayload>,
) -> Result<WorkspaceSessionPayload, String> {
    validate_storage_id("project", project_id)?;
    validate_storage_id("session", session_id)?;
    let metadata: StoredSessionMetadata =
        read_json_or_default(&session_metadata_path(root, project_id, session_id)?)?;
    let history = load_session_history(root, project_id, session_id)?;
    let attachments_root = session_dir(root, project_id, session_id)?;

    let messages = history
        .messages
        .into_iter()
        .map(|message| to_workspace_message(&attachments_root, preview_files, message))
        .collect::<Result<Vec<_>, String>>()?;

    Ok(WorkspaceSessionPayload {
        created_at_ms: metadata.created_at,
        id: metadata.id,
        messages,
        messages_loaded: true,
        model_id: metadata.model_id,
        permission_mode: metadata.permission_mode,
        compacted_context: metadata.compacted_context,
        events: Vec::new(),
        replay_turn_summaries: history
            .turn_summaries
            .into_iter()
            .map(to_workspace_turn_summary)
            .collect(),
        selected_model_uuid: metadata.selected_model_uuid,
        system_prompt_hash: metadata.system_prompt_hash,
        tokenizer_kind: metadata.tokenizer_kind,
        tool_defs_hash: metadata.tool_defs_hash,
        title: metadata.title,
        updated_at_label: compact_time_label(metadata.updated_at),
        updated_at_ms: metadata.updated_at,
    })
}

fn load_project_sessions(root: &Path, project_id: &str) -> Result<Vec<WorkspaceSessionPayload>, String> {
    validate_storage_id("project", project_id)?;
    let project_sessions_dir = project_sessions_dir(root, project_id)?;
    ensure_dir(&project_sessions_dir)?;
    let mut sessions = Vec::new();

    for entry in fs::read_dir(&project_sessions_dir)
        .map_err(|error| format!("Could not read sessions for project {project_id}: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("Could not inspect a session directory: {error}"))?;
        let path = entry.path();

        if !path.is_dir() {
            continue;
        }

        let Some(session_id) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        validate_storage_id("session", session_id)?;
        let metadata: StoredSessionMetadata =
            read_json_or_default(&session_metadata_path(root, project_id, session_id)?)?;
        sessions.push((metadata.updated_at, build_workspace_session_summary(metadata)));
    }

    sessions.sort_by(|left, right| right.0.cmp(&left.0));
    Ok(sessions.into_iter().map(|(_, session)| session).collect())
}

fn write_project_index(root: &Path, projects: &[StoredProjectRecord]) -> Result<(), String> {
    write_json(
        &projects_index_path(root),
        &StoredProjectsFile {
            projects: projects.to_vec(),
        },
    )
}

fn read_projects(root: &Path) -> Result<Vec<StoredProjectRecord>, String> {
    let projects_file: StoredProjectsFile = read_json_or_default(&projects_index_path(root))?;
    Ok(projects_file.projects)
}

fn read_settings(root: &Path) -> Result<StoredSettingsFile, String> {
    read_json_or_default(&settings_path(root))
}

fn write_settings(root: &Path, settings: &StoredSettingsFile) -> Result<(), String> {
    write_json(&settings_path(root), settings)
}

fn build_attachment_record(
    attachments_dir: &Path,
    project_root: &Path,
    message_id: &str,
    preview: &PersistedPreviewFileInput,
) -> Result<StoredAttachmentRecord, String> {
    let message_dir = attachments_dir.join(message_id);
    ensure_dir(&message_dir)?;

    let safe_name = sanitize_file_name(&preview.name);
    let file_name = format!("{}-{}", preview.id, safe_name);
    let absolute_path = message_dir.join(&file_name);

    if Path::new(&preview.path).is_absolute() && Path::new(&preview.path).exists() {
        let absolute_source = PathBuf::from(&preview.path);
        let canonical_source = fs::canonicalize(&absolute_source).map_err(|error| {
            format!(
                "Could not inspect attachment {}: {error}",
                absolute_source.display()
            )
        })?;
        let source_size = fs::metadata(&canonical_source)
            .map_err(|error| {
                format!(
                    "Could not inspect attachment {}: {error}",
                    canonical_source.display()
                )
            })?
            .len();
        validate_attachment_size(source_size, &preview.name)?;

        if canonical_source == project_root || canonical_source.starts_with(project_root) {
            let mime_type = if preview.kind == "image" {
                mime_type_from_extension(&canonical_source)
            } else {
                None
            };

            return Ok(StoredAttachmentRecord {
                id: preview.id.clone(),
                kind: preview.kind.clone(),
                language: preview.language.clone(),
                mime_type,
                name: preview.name.clone(),
                original_path: Some(canonical_source.to_string_lossy().to_string()),
                relative_path: String::new(),
                size_bytes: Some(source_size),
                summary: preview.summary.clone(),
            });
        }

        let bytes = fs::read(&canonical_source).map_err(|error| {
            format!(
                "Could not copy attachment {}: {error}",
                canonical_source.display()
            )
        })?;
        let mime_type = if preview.kind == "image" {
            mime_type_from_extension(&canonical_source)
        } else {
            None
        };

        fs::write(&absolute_path, &bytes).map_err(|error| {
            format!(
                "Could not persist attachment {}: {error}",
                absolute_path.display()
            )
        })?;

        return Ok(StoredAttachmentRecord {
            id: preview.id.clone(),
            kind: preview.kind.clone(),
            language: preview.language.clone(),
            mime_type,
            name: preview.name.clone(),
            original_path: Some(canonical_source.to_string_lossy().to_string()),
            relative_path: format!("attachments/{message_id}/{file_name}"),
            size_bytes: Some(bytes.len() as u64),
            summary: preview.summary.clone(),
        });
    }

    let (bytes, mime_type) = if preview.kind == "image" {
        let image_src = preview
            .image_src
            .as_deref()
            .ok_or_else(|| format!("Could not persist attachment {}.", preview.name))?;
        decode_data_url(image_src)?
    } else {
        (
            preview.content.clone().unwrap_or_default().into_bytes(),
            mime_type_from_extension(Path::new(&preview.name)),
        )
    };
    validate_attachment_size(bytes.len() as u64, &preview.name)?;

    fs::write(&absolute_path, &bytes).map_err(|error| {
        format!(
            "Could not persist attachment {}: {error}",
            absolute_path.display()
        )
    })?;

    Ok(StoredAttachmentRecord {
        id: preview.id.clone(),
        kind: preview.kind.clone(),
        language: preview.language.clone(),
        mime_type,
        name: preview.name.clone(),
        original_path: Some(preview.path.clone()),
        relative_path: format!("attachments/{message_id}/{file_name}"),
        size_bytes: Some(bytes.len() as u64),
        summary: preview.summary.clone(),
    })
}

fn validate_attachment_size(size_bytes: u64, name: &str) -> Result<(), String> {
    if size_bytes > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "{name} is larger than 10 MB and cannot be attached."
        ));
    }

    Ok(())
}

fn build_stored_tool_call(input: PersistedToolCallInput) -> StoredToolCallRecord {
    StoredToolCallRecord {
        id: input.id,
        input: input.input,
        name: input.name,
        status: input.status,
    }
}

fn build_stored_tool_result(input: PersistedToolResultInput) -> StoredToolResultRecord {
    StoredToolResultRecord {
        error: input.error,
        id: input.id,
        output: input.output,
        status: input.status,
        tool_call_id: input.tool_call_id,
    }
}

fn build_stored_step(input: super::types::PersistedMessageStepInput) -> StoredMessageStepRecord {
    StoredMessageStepRecord {
        content: input.content,
        created_at_ms: input.created_at_ms,
        error: input.error,
        id: input.id,
        input: input.input,
        name: input.name,
        output: input.output,
        status: input.status,
        tool_call_id: input.tool_call_id,
        r#type: input.r#type,
    }
}

fn build_stored_turn_summary(input: PersistedTurnSummaryInput) -> StoredTurnSummaryRecord {
    StoredTurnSummaryRecord {
        completed_at_ms: input.completed_at_ms,
        estimated_tokens_image_capable: input.estimated_tokens_image_capable,
        estimated_tokens_text_only: input.estimated_tokens_text_only,
        estimator_version: input.estimator_version,
        message_ids: input.message_ids,
        replay_message_count_image_capable: input.replay_message_count_image_capable,
        replay_message_count_text_only: input.replay_message_count_text_only,
        turn_id: input.turn_id,
    }
}

fn build_stored_message(
    attachments_dir: &Path,
    project_root: &Path,
    preview_file_map: &BTreeMap<String, PersistedPreviewFileInput>,
    message: PersistedMessageInput,
) -> Result<StoredMessageRecord, String> {
    let linked_file_ids = message.linked_file_ids.unwrap_or_default();
    let attachments = linked_file_ids
        .iter()
        .map(|file_id| {
            let preview = preview_file_map.get(file_id).ok_or_else(|| {
                format!("Could not resolve attachment {file_id} while saving the chat.")
            })?;

            build_attachment_record(attachments_dir, project_root, &message.id, preview)
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(StoredMessageRecord {
        assistant_phase: message.assistant_phase,
        completed_at_ms: message.completed_at_ms,
        content: message.content,
        created_at: message.created_at_ms,
        duration_ms: message.duration_ms,
        edited_at_ms: message.edited_at_ms,
        id: message.id,
        linked_file_ids,
        reasoning: message.reasoning,
        reasoning_duration_ms: message.reasoning_duration_ms,
        attachments,
        role: message.role,
        tool_call_id: message.tool_call_id,
        tool_name: message.tool_name,
        turn_id: message.turn_id,
        started_at_ms: message.started_at_ms,
        status: message.status,
        parts: message
            .parts
            .unwrap_or_default()
            .into_iter()
            .map(build_stored_step)
            .collect(),
        tool_calls: message
            .tool_calls
            .unwrap_or_default()
            .into_iter()
            .map(build_stored_tool_call)
            .collect(),
        tool_results: message
            .tool_results
            .unwrap_or_default()
            .into_iter()
            .map(build_stored_tool_result)
            .collect(),
    })
}

pub fn build_workspace_snapshot() -> Result<WorkspaceSnapshotPayload, String> {
    let root = ensure_workspace_storage()?;
    migrate_legacy_storage(&root)?;
    let projects = read_projects(&root)?;
    let settings = read_settings(&root)?;
    let mut preview_files = BTreeMap::new();

    let projects = projects
        .into_iter()
        .map(|project| {
            validate_storage_id("project", &project.id)?;
            Ok(WorkspaceProjectPayload {
                created_at_ms: project.created_at,
                id: project.id.clone(),
                is_expanded: project.is_expanded,
                name: project.name,
                root_path: project.root_path,
                sessions: load_project_sessions(&root, &project.id)?,
                updated_at_ms: project.updated_at,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let selected_project_id = settings
        .selected_project_id
        .filter(|project_id| projects.iter().any(|project| &project.id == project_id))
        .or_else(|| projects.first().map(|project| project.id.clone()))
        .unwrap_or_default();

    let selected_session_id = projects
        .iter()
        .find(|project| project.id == selected_project_id)
        .and_then(|project| {
            settings
                .selected_session_id
                .clone()
                .filter(|session_id| {
                    project
                        .sessions
                        .iter()
                        .any(|session| &session.id == session_id)
                })
                .or_else(|| project.sessions.first().map(|session| session.id.clone()))
        });

    let mut projects = projects;

    if let Some(selected_session_id_value) = selected_session_id.as_deref() {
        if let Some(project) = projects
            .iter_mut()
            .find(|project| project.id == selected_project_id)
        {
            if let Some(index) = project
                .sessions
                .iter()
                .position(|session| session.id == selected_session_id_value)
            {
                project.sessions[index] = load_workspace_session_payload(
                    &root,
                    &selected_project_id,
                    selected_session_id_value,
                    &mut preview_files,
                )?;
            }
        }
    }

    let snapshot = WorkspaceSnapshotPayload {
        is_file_panel_open: settings.is_file_panel_open,
        is_sidebar_open: settings.is_sidebar_open,
        model_id: settings.model_id,
        permission_mode: settings.permission_mode,
        preview_files: preview_files.into_values().collect(),
        projects,
        selected_project_id,
        selected_session_id,
    };

    log_desktop_event(
        "info",
        "desktop.workspace",
        "snapshot_built",
        json!({
            "projectCount": snapshot.projects.len(),
            "previewFileCount": snapshot.preview_files.len(),
            "selectedProjectIdLength": snapshot.selected_project_id.len(),
            "selectedSessionPresent": snapshot.selected_session_id.is_some(),
        }),
    );

    Ok(snapshot)
}

pub fn load_workspace_session(
    input: super::types::LoadWorkspaceSessionInput,
) -> Result<WorkspaceSessionLoadPayload, String> {
    let root = ensure_workspace_storage()?;
    migrate_legacy_storage(&root)?;
    validate_storage_id("project", &input.project_id)?;
    validate_storage_id("session", &input.session_id)?;

    let mut preview_files = BTreeMap::new();
    let session = load_workspace_session_payload(
        &root,
        &input.project_id,
        &input.session_id,
        &mut preview_files,
    )?;

    Ok(WorkspaceSessionLoadPayload {
        preview_files: preview_files.into_values().collect(),
        session,
    })
}

pub fn add_project_from_path(root_path: &str) -> Result<WorkspaceSnapshotPayload, String> {
    let root = ensure_workspace_storage()?;
    migrate_legacy_storage(&root)?;
    let mut projects = read_projects(&root)?;
    let mut settings = read_settings(&root)?;
    let normalized_root_path = canonical_display_path(Path::new(root_path));

    if let Some(existing_project) = projects
        .iter()
        .find(|project| {
            canonical_display_path(Path::new(&project.root_path)) == normalized_root_path
        })
        .cloned()
    {
        settings.selected_project_id = Some(existing_project.id.clone());
        settings.selected_session_id = None;
        write_settings(&root, &settings)?;
        return build_workspace_snapshot();
    }

    let timestamp = now_unix_ms();
    let project_id = format!("project-{timestamp}");
    let normalized_root_path_length = normalized_root_path.len();
    let project_name = Path::new(&normalized_root_path)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(&normalized_root_path)
        .to_string();
    let project_record = StoredProjectRecord {
        created_at: timestamp,
        id: project_id.clone(),
        is_expanded: true,
        name: project_name,
        root_path: normalized_root_path,
        updated_at: timestamp,
    };

    projects.insert(0, project_record.clone());
    write_project_index(&root, &projects)?;
    ensure_dir(&project_dir(&root, &project_id)?)?;
    ensure_dir(&project_sessions_dir(&root, &project_id)?)?;
    write_json(&project_metadata_path(&root, &project_id)?, &project_record)?;

    settings.selected_project_id = Some(project_id);
    settings.selected_session_id = None;
    write_settings(&root, &settings)?;

    log_desktop_event(
        "info",
        "desktop.workspace",
        "project_added",
        json!({
            "projectCount": projects.len(),
            "rootPathLength": normalized_root_path_length,
        }),
    );

    build_workspace_snapshot()
}

pub fn remove_project_by_id(project_id: &str) -> Result<WorkspaceSnapshotPayload, String> {
    let root = ensure_workspace_storage()?;
    migrate_legacy_storage(&root)?;
    validate_storage_id("project", project_id)?;
    let mut projects = read_projects(&root)?;
    let mut settings = read_settings(&root)?;

    if !projects.iter().any(|project| project.id == project_id) {
        return build_workspace_snapshot();
    }

    projects.retain(|project| project.id != project_id);
    write_project_index(&root, &projects)?;

    let target_project_dir = project_dir(&root, project_id)?;
    if target_project_dir.exists() {
        fs::remove_dir_all(&target_project_dir).map_err(|error| {
            format!("Could not remove local sessions for project {project_id}: {error}")
        })?;
    }

    let next_selected_project_id = projects.first().map(|project| project.id.clone());
    settings.selected_project_id = next_selected_project_id;
    settings.selected_session_id = None;
    write_settings(&root, &settings)?;

    log_desktop_event(
        "info",
        "desktop.workspace",
        "project_removed",
        json!({
            "projectIdLength": project_id.len(),
            "remainingProjectCount": projects.len(),
        }),
    );

    build_workspace_snapshot()
}

pub fn save_workspace_settings(input: SaveWorkspaceSettingsInput) -> Result<(), String> {
    let root = ensure_workspace_storage()?;
    migrate_legacy_storage(&root)?;
    let settings = StoredSettingsFile {
        is_file_panel_open: input.is_file_panel_open,
        is_sidebar_open: input.is_sidebar_open,
        model_id: input.model_id,
        permission_mode: input.permission_mode,
        selected_project_id: input.selected_project_id,
        selected_session_id: input.selected_session_id,
    };
    write_settings(&root, &settings)
}

pub fn set_project_expanded(input: SetProjectExpandedInput) -> Result<(), String> {
    let root = ensure_workspace_storage()?;
    migrate_legacy_storage(&root)?;
    validate_storage_id("project", &input.project_id)?;
    let mut projects = read_projects(&root)?;

    let Some(project) = projects
        .iter_mut()
        .find(|project| project.id == input.project_id)
    else {
        return Ok(());
    };

    project.is_expanded = input.is_expanded;
    project.updated_at = now_unix_ms();
    write_json(&project_metadata_path(&root, &project.id)?, project)?;
    write_project_index(&root, &projects)
}

pub fn rename_session(input: RenameSessionInput) -> Result<WorkspaceSnapshotPayload, String> {
    let root = ensure_workspace_storage()?;
    migrate_legacy_storage(&root)?;
    validate_storage_id("project", &input.project_id)?;
    validate_storage_id("session", &input.session_id)?;
    let normalized_title = input.title.trim();

    if normalized_title.is_empty() {
        return build_workspace_snapshot();
    }

    let metadata_path = session_metadata_path(&root, &input.project_id, &input.session_id)?;
    let mut metadata: StoredSessionMetadata = read_json_or_default(&metadata_path)?;

    if metadata.id.is_empty() {
        return build_workspace_snapshot();
    }

    metadata.title = normalized_title.to_string();
    metadata.updated_at = now_unix_ms();
    write_json(&metadata_path, &metadata)?;

    let mut projects = read_projects(&root)?;
    if let Some(project) = projects
        .iter_mut()
        .find(|project| project.id == input.project_id)
    {
        project.updated_at = metadata.updated_at;
        write_json(&project_metadata_path(&root, &project.id)?, project)?;
        write_project_index(&root, &projects)?;
    }

    log_desktop_event(
        "info",
        "desktop.workspace",
        "session_renamed",
        json!({
            "projectIdLength": input.project_id.len(),
            "sessionIdLength": input.session_id.len(),
            "titleLength": normalized_title.len(),
        }),
    );

    build_workspace_snapshot()
}

pub fn delete_session(input: DeleteSessionInput) -> Result<WorkspaceSnapshotPayload, String> {
    let root = ensure_workspace_storage()?;
    migrate_legacy_storage(&root)?;
    validate_storage_id("project", &input.project_id)?;
    validate_storage_id("session", &input.session_id)?;
    let mut settings = read_settings(&root)?;
    let session_directory = session_dir(&root, &input.project_id, &input.session_id)?;

    if session_directory.exists() {
        fs::remove_dir_all(&session_directory).map_err(|error| {
            format!(
                "Could not delete session {} from project {}: {error}",
                input.session_id, input.project_id
            )
        })?;
    }

    if settings.selected_project_id.as_deref() == Some(input.project_id.as_str())
        && settings.selected_session_id.as_deref() == Some(input.session_id.as_str())
    {
        settings.selected_session_id = None;
        write_settings(&root, &settings)?;
    }

    let mut projects = read_projects(&root)?;
    if let Some(project) = projects
        .iter_mut()
        .find(|project| project.id == input.project_id)
    {
        project.updated_at = now_unix_ms();
        write_json(&project_metadata_path(&root, &project.id)?, project)?;
        write_project_index(&root, &projects)?;
    }

    log_desktop_event(
        "info",
        "desktop.workspace",
        "session_deleted",
        json!({
            "projectIdLength": input.project_id.len(),
            "sessionIdLength": input.session_id.len(),
        }),
    );

    build_workspace_snapshot()
}

pub fn persist_session(input: PersistWorkspaceSessionInput) -> Result<(), String> {
    let root = ensure_workspace_storage()?;
    migrate_legacy_storage(&root)?;
    let session_id = input.session.id.clone();
    validate_storage_id("project", &input.project_id)?;
    validate_storage_id("session", &session_id)?;
    let session_title = input.session.title.trim().to_string();

    if session_title.is_empty() {
        return Err("Could not save a session without a title.".to_string());
    }

    let session_dir_path = session_dir(&root, &input.project_id, &session_id)?;
    ensure_dir(&session_dir_path)?;
    let attachments_dir = session_attachments_dir(&root, &input.project_id, &session_id)?;
    let staged_attachments_dir = session_dir_path.join("attachments.staging");
    let backup_attachments_dir = session_dir_path.join("attachments.backup");
    let project_root = resolve_project_root(&input.project_id)?;

    if staged_attachments_dir.exists() {
        fs::remove_dir_all(&staged_attachments_dir).map_err(|error| {
            format!(
                "Could not prepare attachment staging for session {}: {error}",
                session_id
            )
        })?;
    }

    if backup_attachments_dir.exists() {
        fs::remove_dir_all(&backup_attachments_dir).map_err(|error| {
            format!(
                "Could not clear the attachment backup for session {}: {error}",
                session_id
            )
        })?;
    }

    ensure_dir(&staged_attachments_dir)?;

    let session_input = input.session;
    let preview_file_map = input
        .preview_files
        .into_iter()
        .map(|preview| (preview.id.clone(), preview))
        .collect::<BTreeMap<_, _>>();
    let turn_summaries = session_input
        .replay_turn_summaries
        .unwrap_or_default()
        .into_iter()
        .map(build_stored_turn_summary)
        .collect::<Vec<_>>();
    let messages = session_input
        .messages
        .into_iter()
        .map(|message| {
            build_stored_message(
                &staged_attachments_dir,
                &project_root,
                &preview_file_map,
                message,
            )
        })
        .collect::<Result<Vec<_>, String>>()?;
    let message_count = messages.len();
    let now = now_unix_ms();
    let metadata = StoredSessionMetadata {
        created_at: session_input.created_at_ms,
        id: session_id.clone(),
        model_id: session_input.model_id,
        permission_mode: session_input.permission_mode,
        project_id: input.project_id.clone(),
        selected_model_uuid: session_input.selected_model_uuid,
        system_prompt_hash: session_input.system_prompt_hash,
        tokenizer_kind: session_input.tokenizer_kind,
        tool_defs_hash: session_input.tool_defs_hash,
        title: session_title,
        updated_at: session_input.updated_at_ms.max(now),
    };
    let history_records = messages
        .into_iter()
        .map(|message| StoredSessionHistoryRecord::Message { message })
        .chain(
            turn_summaries
                .into_iter()
                .map(|summary| StoredSessionHistoryRecord::TurnSummary { summary }),
        )
        .collect::<Vec<_>>();

    if attachments_dir.exists() {
        fs::rename(&attachments_dir, &backup_attachments_dir).map_err(|error| {
            format!(
                "Could not rotate existing attachments for session {}: {error}",
                session_id
            )
        })?;
    }

    if let Err(error) = fs::rename(&staged_attachments_dir, &attachments_dir) {
        if backup_attachments_dir.exists() {
            let _ = fs::rename(&backup_attachments_dir, &attachments_dir);
        }

        return Err(format!(
            "Could not finalize attachments for session {}: {error}",
            session_id
        ));
    }

    let persist_result = write_json(
        &session_metadata_path(&root, &input.project_id, &session_id)?,
        &metadata,
    )
    .and_then(|_| {
        write_session_history_records(
            &session_messages_path(&root, &input.project_id, &session_id)?,
            &history_records,
        )
    })
    .and_then(|_| {
        let mut projects = read_projects(&root)?;
        if let Some(project) = projects
            .iter_mut()
            .find(|project| project.id == input.project_id)
        {
            project.updated_at = metadata.updated_at;
            write_json(&project_metadata_path(&root, &project.id)?, project)?;
            write_project_index(&root, &projects)?;
        }

        let mut settings = read_settings(&root)?;
        settings.selected_project_id = input.selected_project_id;
        settings.selected_session_id = input.selected_session_id;
        write_settings(&root, &settings)
    });

    if let Err(error) = persist_result {
        let _ = fs::remove_dir_all(&attachments_dir);

        if backup_attachments_dir.exists() {
            let _ = fs::rename(&backup_attachments_dir, &attachments_dir);
        }

        return Err(error);
    }

    if backup_attachments_dir.exists() {
        fs::remove_dir_all(&backup_attachments_dir).map_err(|error| {
            format!(
                "Could not clean up the previous attachment backup for session {}: {error}",
                session_id
            )
        })?;
    }

    log_desktop_event(
        "info",
        "desktop.workspace",
        "session_persisted",
        json!({
            "projectIdLength": input.project_id.len(),
            "sessionIdLength": session_id.len(),
            "messageCount": message_count,
            "previewFileCount": preview_file_map.len(),
        }),
    );

    Ok(())
}

pub fn resolve_project_root(project_id: &str) -> Result<PathBuf, String> {
    let root = ensure_workspace_storage()?;
    migrate_legacy_storage(&root)?;
    validate_storage_id("project", project_id)?;
    let projects = read_projects(&root)?;
    let project = projects
        .into_iter()
        .find(|entry| entry.id == project_id)
        .ok_or_else(|| format!("Could not find project {project_id}."))?;

    Ok(PathBuf::from(project.root_path))
}
