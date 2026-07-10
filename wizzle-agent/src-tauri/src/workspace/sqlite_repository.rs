use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

use crate::logging::log_desktop_event;

use super::{
    paths::{
        database_path, ensure_dir, ensure_workspace_storage, session_cache_dir,
        sqlite_session_attachments_dir, sqlite_session_dir, validate_storage_id,
    },
    types::{
        AppendOrUpdateMessageInput, AttachmentPreviewPayload, DeleteSessionInput,
        FinalizeTurnInput, LoadComposerStateInput, LoadWorkspaceSessionInput,
        PersistSessionMetadataInput, PersistWorkspaceSessionInput, PersistedMessageInput,
        PersistedPreviewFileInput, PersistedQueuedMessageInput, PersistedSessionMetadataInput,
        PersistedToolCallInput, PersistedToolResultInput, PersistedTurnSummaryInput,
        RenameSessionInput, SaveComposerStateInput, SaveWorkspaceSettingsInput,
        SetProjectExpandedInput, StoredAttachmentRecord, StoredMessageRecord,
        StoredMessageStepRecord, StoredProjectRecord, StoredSessionMetadata, StoredSettingsFile,
        StoredToolCallRecord, StoredToolResultRecord, StoredTurnSummaryRecord,
        TruncateSessionTranscriptInput, UpdateSessionSelectionInput, UpdateSessionTitleInput,
        UpsertTurnSummaryInput, WorkspaceCompactedContextPayload, WorkspaceComposerStatePayload,
        WorkspaceMessagePayload, WorkspaceMessageStepPayload, WorkspaceProjectPayload,
        WorkspaceQueuedMessagePayload, WorkspaceSessionLoadPayload, WorkspaceSessionPayload,
        WorkspaceSnapshotPayload, WorkspaceToolCallPayload, WorkspaceToolResultPayload,
        WorkspaceTurnSummaryPayload,
    },
    MAX_ATTACHMENT_BYTES,
};

const MIGRATION_VERSION: i64 = 1;
const PROCESS_TAIL_BYTES: usize = 60_000;
static MIGRATED_DATABASES: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProcessPayload {
    pub command: String,
    pub cwd: String,
    pub ended_at_ms: Option<u64>,
    pub exit_code: Option<i64>,
    pub id: String,
    pub pid: Option<i64>,
    pub session_id: String,
    pub started_at_ms: u64,
    pub status: String,
    pub stderr_tail: String,
    pub stdout_tail: String,
    /// Conversation turn that spawned this process (#75).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

pub struct NewProcessRecord {
    pub command: String,
    pub cwd: String,
    pub id: String,
    pub pid: Option<u32>,
    pub session_id: String,
    pub started_at_ms: u64,
    pub status: String,
    pub tool_call_id: Option<String>,
    pub turn_id: Option<String>,
}

pub(crate) fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn db_error(context: &str, error: rusqlite::Error) -> String {
    format!("{context}: {error}")
}

fn io_error(context: &str, error: std::io::Error) -> String {
    format!("{context}: {error}")
}

fn append_tail(existing: &str, chunk: &str, max_bytes: usize) -> String {
    if chunk.is_empty() {
        return existing.to_string();
    }

    let combined = format!("{existing}{chunk}");

    if combined.len() <= max_bytes {
        return combined;
    }

    let mut start_index = combined.len().saturating_sub(max_bytes);
    while start_index < combined.len() && !combined.is_char_boundary(start_index) {
        start_index += 1;
    }

    combined[start_index..].to_string()
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

fn new_project_id() -> String {
    format!("project-{}", Uuid::new_v4())
}

fn read_compacted_context_from_row(
    row: &Row<'_>,
    summary_index: usize,
    tokens_index: usize,
    updated_at_index: usize,
) -> rusqlite::Result<Option<WorkspaceCompactedContextPayload>> {
    let summary: Option<String> = row.get(summary_index)?;
    let Some(summary) = summary.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let tokens = row.get::<_, i64>(tokens_index).unwrap_or(0).max(0) as u64;
    let updated_at_ms = row
        .get::<_, Option<i64>>(updated_at_index)?
        .unwrap_or(0)
        .max(0) as u64;

    Ok(Some(WorkspaceCompactedContextPayload {
        compacted_turn_ids: Vec::new(),
        summary,
        tokens,
        updated_at_ms,
    }))
}

fn read_compacted_turn_ids(conn: &Connection, session_id: &str) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(
            "
            SELECT id
            FROM turns
            WHERE session_id = ?1
              AND compacted = 1
            ORDER BY turn_index ASC
            ",
        )
        .map_err(|error| db_error("Could not prepare compacted turn loading", error))?;
    let rows = statement
        .query_map(params![session_id], |row| row.get::<_, String>(0))
        .map_err(|error| db_error("Could not read compacted turns", error))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not parse compacted turns", error))
}

fn canonical_display_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn content_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
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

pub(crate) fn open_database() -> Result<Connection, String> {
    let root = ensure_workspace_storage()?;
    let db_path = database_path(&root);
    let mut conn = Connection::open(&db_path)
        .map_err(|error| db_error("Could not open the Wizzle SQLite database", error))?;

    conn.execute_batch(
        "
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        PRAGMA busy_timeout=5000;
        ",
    )
    .map_err(|error| db_error("Could not configure the Wizzle SQLite database", error))?;
    ensure_database_migrated(&mut conn, &db_path)?;

    Ok(conn)
}

fn ensure_database_migrated(conn: &mut Connection, db_path: &Path) -> Result<(), String> {
    let migrated_databases = MIGRATED_DATABASES.get_or_init(|| Mutex::new(HashSet::new()));
    let mut migrated_databases = migrated_databases
        .lock()
        .map_err(|_| "Could not coordinate Wizzle database migrations.".to_string())?;

    if migrated_databases.contains(db_path) {
        return Ok(());
    }

    run_migrations(conn)?;
    migrated_databases.insert(db_path.to_path_buf());
    Ok(())
}

pub(crate) fn resolve_session_tool_permission(
    session_id: &str,
    project_id: &str,
) -> Result<String, String> {
    let conn = open_database()?;
    conn.query_row(
        "SELECT permission_mode FROM sessions WHERE id = ?1 AND project_id = ?2",
        params![session_id, project_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|error| db_error("Could not verify the tool permission mode", error))?
    .ok_or_else(|| "The tool request does not belong to a stored project session.".to_string())
}

fn run_migrations(conn: &mut Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        ",
    )
    .map_err(|error| db_error("Could not initialize Wizzle migrations", error))?;

    let applied: Option<i64> = conn
        .query_row(
            "SELECT version FROM schema_migrations WHERE version = ?1",
            params![MIGRATION_VERSION],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| db_error("Could not read Wizzle migrations", error))?;

    if applied.is_some() {
        // Includes turn part + turn budget column ensures / legacy summary migration.
        ensure_session_metadata_columns(conn)?;
        ensure_process_link_columns(conn)?;
        ensure_tokenizer_json_columns(conn)?;
        repair_self_parent_tool_calls(conn)?;
        return Ok(());
    }

    let tx = conn
        .transaction()
        .map_err(|error| db_error("Could not start the Wizzle migration", error))?;

    tx.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          api_key_encrypted BLOB NULL,
          default_model_id TEXT NULL,
          tokenizer_json TEXT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS models (
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          model_id TEXT NOT NULL,
          display_name TEXT NULL,
          capabilities TEXT NOT NULL,
          reasoning_levels TEXT NOT NULL,
          max_context INTEGER NOT NULL,
          max_output_tokens INTEGER NULL,
          tokenizer_kind TEXT NULL,
          tokenizer_json TEXT NULL,
          is_pinned INTEGER NOT NULL DEFAULT 0,
          last_used_at INTEGER NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(provider_id, model_id)
        );

        CREATE TABLE IF NOT EXISTS provider_imports (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          imported_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          is_expanded INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          selected_provider_id TEXT NULL REFERENCES providers(id) ON DELETE SET NULL,
          selected_model_uuid TEXT NULL REFERENCES models(id) ON DELETE SET NULL,
          selected_model_id TEXT NULL,
          tokenizer_kind TEXT NULL,
          selected_reasoning_level TEXT NULL,
          system_prompt_tokens INTEGER NOT NULL DEFAULT 0,
          system_prompt_hash TEXT NOT NULL DEFAULT '',
          tool_def_tokens INTEGER NOT NULL DEFAULT 0,
          tool_defs_hash TEXT NOT NULL DEFAULT '',
          last_compacted_tokens INTEGER NOT NULL DEFAULT 0,
          last_compacted_at INTEGER NULL,
          last_compacted_summary TEXT NULL,
          max_context INTEGER NOT NULL DEFAULT 128000,
          model_id TEXT NULL,
          permission_mode TEXT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS composer_drafts (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          draft_text TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS queued_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          attachments_json TEXT NOT NULL,
          queue_index INTEGER NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS turns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          turn_index INTEGER NOT NULL,
          status TEXT NOT NULL,
          compacted INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          estimated_tokens_image_capable INTEGER NULL,
          estimated_tokens_text_only INTEGER NULL,
          estimator_version INTEGER NULL,
          replay_message_count_image_capable INTEGER NULL,
          replay_message_count_text_only INTEGER NULL,
          summary_message_ids TEXT NULL,
          summary_completed_at INTEGER NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(session_id, turn_index)
        );

        CREATE TABLE IF NOT EXISTS turn_parts (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          part_type TEXT NOT NULL,
          content TEXT NULL,
          tokens INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'done',
          parent_part_id TEXT NULL REFERENCES turn_parts(id) ON DELETE SET NULL,
          tool_call_id TEXT NULL,
          message_id TEXT NULL,
          tool_name TEXT NULL,
          tool_arguments TEXT NULL,
          tool_output TEXT NULL,
          tool_error TEXT NULL,
          assistant_phase TEXT NULL,
          started_at INTEGER NULL,
          completed_at INTEGER NULL,
          duration_ms INTEGER NULL,
          edited_at INTEGER NULL,
          summary_turn_id TEXT NULL,
          summary_message_ids TEXT NULL,
          estimated_tokens_image_capable INTEGER NULL,
          estimated_tokens_text_only INTEGER NULL,
          estimator_version INTEGER NULL,
          replay_message_count_image_capable INTEGER NULL,
          replay_message_count_text_only INTEGER NULL,
          part_index INTEGER NOT NULL,
          pruned INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(turn_id, part_index)
        );

        CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY,
          turn_part_id TEXT NOT NULL REFERENCES turn_parts(id) ON DELETE CASCADE,
          original_path TEXT NOT NULL,
          stored_path TEXT NULL,
          real_path TEXT NOT NULL,
          kind TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size INTEGER NOT NULL DEFAULT 0,
          content_hash TEXT NOT NULL DEFAULT '',
          preview TEXT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS processes (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          command TEXT NOT NULL,
          cwd TEXT NOT NULL,
          pid INTEGER NULL,
          status TEXT NOT NULL,
          exit_code INTEGER NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER NULL,
          stdout_tail TEXT NOT NULL DEFAULT '',
          stderr_tail TEXT NOT NULL DEFAULT '',
          turn_id TEXT NULL,
          tool_call_id TEXT NULL
        );

        CREATE TABLE IF NOT EXISTS workspace_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          is_file_panel_open INTEGER NOT NULL,
          is_sidebar_open INTEGER NOT NULL,
          model_id TEXT NOT NULL,
          permission_mode TEXT NOT NULL,
          selected_project_id TEXT NULL,
          selected_session_id TEXT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_turns_session_index
        ON turns(session_id, turn_index);

        CREATE INDEX IF NOT EXISTS idx_turns_session_compacted_status
        ON turns(session_id, compacted, status, turn_index);

        CREATE INDEX IF NOT EXISTS idx_turn_parts_turn_index
        ON turn_parts(turn_id, part_index);

        CREATE INDEX IF NOT EXISTS idx_files_turn_part
        ON files(turn_part_id);

        CREATE INDEX IF NOT EXISTS idx_processes_session_status
        ON processes(session_id, status);
        ",
    )
    .map_err(|error| db_error("Could not apply the Wizzle SQLite schema", error))?;

    let defaults = StoredSettingsFile::default();
    tx.execute(
        "
        INSERT OR IGNORE INTO workspace_settings (
          id,
          is_file_panel_open,
          is_sidebar_open,
          model_id,
          permission_mode,
          selected_project_id,
          selected_session_id
        ) VALUES (1, ?1, ?2, ?3, ?4, NULL, NULL)
        ",
        params![
            bool_to_i64(defaults.is_file_panel_open),
            bool_to_i64(defaults.is_sidebar_open),
            defaults.model_id,
            defaults.permission_mode
        ],
    )
    .map_err(|error| db_error("Could not initialize Wizzle settings", error))?;

    tx.execute(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
        params![
            MIGRATION_VERSION,
            "sqlite_workspace_foundation",
            now_unix_ms() as i64
        ],
    )
    .map_err(|error| db_error("Could not record the Wizzle migration", error))?;

    tx.commit()
        .map_err(|error| db_error("Could not commit the Wizzle migration", error))?;

    ensure_session_metadata_columns(conn)?;
    ensure_turn_budget_columns(conn)?;
    ensure_process_link_columns(conn)?;
    ensure_tokenizer_json_columns(conn)?;
    repair_self_parent_tool_calls(conn)?;
    Ok(())
}

/// Provider/model HuggingFace tokenizer.json source paths (#53).
fn ensure_tokenizer_json_columns(conn: &Connection) -> Result<(), String> {
    if !table_has_column(conn, "providers", "tokenizer_json")? {
        conn.execute(
            "ALTER TABLE providers ADD COLUMN tokenizer_json TEXT NULL",
            [],
        )
        .map_err(|error| db_error("Could not update provider tokenizer columns", error))?;
    }

    if !table_has_column(conn, "models", "tokenizer_json")? {
        conn.execute("ALTER TABLE models ADD COLUMN tokenizer_json TEXT NULL", [])
            .map_err(|error| db_error("Could not update model tokenizer columns", error))?;
    }

    Ok(())
}

/// Link background processes to the turn/tool that spawned them (#75).
fn ensure_process_link_columns(conn: &Connection) -> Result<(), String> {
    for (column_name, column_type) in [("turn_id", "TEXT NULL"), ("tool_call_id", "TEXT NULL")] {
        if !table_has_column(conn, "processes", column_name)? {
            conn.execute(
                &format!("ALTER TABLE processes ADD COLUMN {column_name} {column_type}"),
                [],
            )
            .map_err(|error| db_error("Could not update Wizzle process link columns", error))?;
        }
    }

    Ok(())
}

/// Repair tool_call rows that parented themselves (re-upsert bug).
fn repair_self_parent_tool_calls(conn: &Connection) -> Result<(), String> {
    if !table_has_column(conn, "turn_parts", "parent_part_id")?
        || !table_has_column(conn, "turn_parts", "message_id")?
    {
        return Ok(());
    }

    conn.execute(
        "
        UPDATE turn_parts
        SET parent_part_id = message_id
        WHERE part_type = 'tool_call'
          AND parent_part_id IS NOT NULL
          AND parent_part_id = id
          AND message_id IS NOT NULL
          AND message_id != ''
          AND message_id != id
        ",
        [],
    )
    .map_err(|error| db_error("Could not repair self-parent tool_call parts", error))?;

    Ok(())
}

fn table_has_column(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
) -> Result<bool, String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|error| db_error("Could not inspect the Wizzle SQLite schema", error))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| db_error("Could not read the Wizzle SQLite schema", error))?;

    for row in rows {
        if row.map_err(|error| db_error("Could not parse the Wizzle SQLite schema", error))?
            == column_name
        {
            return Ok(true);
        }
    }

    Ok(false)
}

fn table_column_is_not_null(
    conn: &Connection,
    table_name: &str,
    column_name: &str,
) -> Result<bool, String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|error| db_error("Could not inspect the Wizzle SQLite schema", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(3)?))
        })
        .map_err(|error| db_error("Could not read the Wizzle SQLite schema", error))?;

    for row in rows {
        let (name, not_null) =
            row.map_err(|error| db_error("Could not parse the Wizzle SQLite schema", error))?;
        if name == column_name {
            return Ok(not_null != 0);
        }
    }

    Ok(false)
}

fn rebuild_turn_parts_for_nullable_content(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        PRAGMA foreign_keys=OFF;

        CREATE TABLE turn_parts_new (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          part_type TEXT NOT NULL,
          content TEXT NULL,
          tokens INTEGER NOT NULL DEFAULT 0,
          metadata TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'done',
          parent_part_id TEXT NULL REFERENCES turn_parts(id) ON DELETE SET NULL,
          tool_call_id TEXT NULL,
          message_id TEXT NULL,
          tool_name TEXT NULL,
          tool_arguments TEXT NULL,
          tool_output TEXT NULL,
          tool_error TEXT NULL,
          assistant_phase TEXT NULL,
          started_at INTEGER NULL,
          completed_at INTEGER NULL,
          duration_ms INTEGER NULL,
          edited_at INTEGER NULL,
          summary_turn_id TEXT NULL,
          summary_message_ids TEXT NULL,
          estimated_tokens_image_capable INTEGER NULL,
          estimated_tokens_text_only INTEGER NULL,
          estimator_version INTEGER NULL,
          replay_message_count_image_capable INTEGER NULL,
          replay_message_count_text_only INTEGER NULL,
          part_index INTEGER NOT NULL,
          pruned INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(turn_id, part_index)
        );

        INSERT INTO turn_parts_new (
          id, turn_id, role, part_type, content, tokens, metadata, status,
          parent_part_id, tool_call_id, part_index, pruned, created_at, updated_at
        )
        SELECT
          id, turn_id, role, part_type, content, tokens, metadata, status,
          parent_part_id, tool_call_id, part_index, pruned, created_at, updated_at
        FROM turn_parts;

        DROP TABLE turn_parts;
        ALTER TABLE turn_parts_new RENAME TO turn_parts;

        CREATE INDEX IF NOT EXISTS idx_turn_parts_turn_index
        ON turn_parts(turn_id, part_index);

        PRAGMA foreign_keys=ON;
        ",
    )
    .map_err(|error| db_error("Could not rebuild Wizzle turn part storage", error))
}

fn ensure_session_metadata_columns(conn: &Connection) -> Result<(), String> {
    if !table_has_column(conn, "sessions", "selected_provider_id")? {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN selected_provider_id TEXT NULL REFERENCES providers(id) ON DELETE SET NULL",
            [],
        )
        .map_err(|error| db_error("Could not update Wizzle session metadata", error))?;
    }

    if !table_has_column(conn, "sessions", "selected_model_uuid")? {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN selected_model_uuid TEXT NULL REFERENCES models(id) ON DELETE SET NULL",
            [],
        )
        .map_err(|error| db_error("Could not update Wizzle session metadata", error))?;
    }

    if !table_has_column(conn, "sessions", "selected_model_id")? {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN selected_model_id TEXT NULL",
            [],
        )
        .map_err(|error| db_error("Could not update Wizzle session metadata", error))?;
    }

    if !table_has_column(conn, "sessions", "model_id")? {
        conn.execute("ALTER TABLE sessions ADD COLUMN model_id TEXT NULL", [])
            .map_err(|error| db_error("Could not update Wizzle session metadata", error))?;
    }

    if !table_has_column(conn, "sessions", "tokenizer_kind")? {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN tokenizer_kind TEXT NULL",
            [],
        )
        .map_err(|error| db_error("Could not update Wizzle session metadata", error))?;
    }

    ensure_turn_part_columns(conn)?;
    ensure_turn_budget_columns(conn)
}

/// Budget cache columns live on the real conversation turn (#71), not summary-* turns.
fn ensure_turn_budget_columns(conn: &Connection) -> Result<(), String> {
    let columns = [
        ("estimated_tokens_image_capable", "INTEGER NULL"),
        ("estimated_tokens_text_only", "INTEGER NULL"),
        ("estimator_version", "INTEGER NULL"),
        ("replay_message_count_image_capable", "INTEGER NULL"),
        ("replay_message_count_text_only", "INTEGER NULL"),
        ("summary_message_ids", "TEXT NULL"),
        ("summary_completed_at", "INTEGER NULL"),
    ];

    for (column_name, column_type) in columns {
        if !table_has_column(conn, "turns", column_name)? {
            conn.execute(
                &format!("ALTER TABLE turns ADD COLUMN {column_name} {column_type}"),
                [],
            )
            .map_err(|error| db_error("Could not update Wizzle turn budget columns", error))?;
        }
    }

    migrate_legacy_summary_turns_onto_real_turns(conn)?;
    Ok(())
}

/// One-time: copy budget fields from summary-* turn_parts onto real turns, then drop fake turns.
fn migrate_legacy_summary_turns_onto_real_turns(conn: &Connection) -> Result<(), String> {
    if !table_has_column(conn, "turn_parts", "summary_turn_id")? {
        return Ok(());
    }

    conn.execute_batch(
        "
        UPDATE turns
        SET
          estimated_tokens_image_capable = (
            SELECT tp.estimated_tokens_image_capable
            FROM turn_parts tp
            WHERE tp.part_type = 'turn_summary'
              AND tp.summary_turn_id = turns.id
            ORDER BY tp.updated_at DESC
            LIMIT 1
          ),
          estimated_tokens_text_only = (
            SELECT tp.estimated_tokens_text_only
            FROM turn_parts tp
            WHERE tp.part_type = 'turn_summary'
              AND tp.summary_turn_id = turns.id
            ORDER BY tp.updated_at DESC
            LIMIT 1
          ),
          estimator_version = (
            SELECT tp.estimator_version
            FROM turn_parts tp
            WHERE tp.part_type = 'turn_summary'
              AND tp.summary_turn_id = turns.id
            ORDER BY tp.updated_at DESC
            LIMIT 1
          ),
          replay_message_count_image_capable = (
            SELECT tp.replay_message_count_image_capable
            FROM turn_parts tp
            WHERE tp.part_type = 'turn_summary'
              AND tp.summary_turn_id = turns.id
            ORDER BY tp.updated_at DESC
            LIMIT 1
          ),
          replay_message_count_text_only = (
            SELECT tp.replay_message_count_text_only
            FROM turn_parts tp
            WHERE tp.part_type = 'turn_summary'
              AND tp.summary_turn_id = turns.id
            ORDER BY tp.updated_at DESC
            LIMIT 1
          ),
          summary_message_ids = (
            SELECT tp.summary_message_ids
            FROM turn_parts tp
            WHERE tp.part_type = 'turn_summary'
              AND tp.summary_turn_id = turns.id
            ORDER BY tp.updated_at DESC
            LIMIT 1
          ),
          summary_completed_at = (
            SELECT COALESCE(tp.completed_at, tp.updated_at)
            FROM turn_parts tp
            WHERE tp.part_type = 'turn_summary'
              AND tp.summary_turn_id = turns.id
            ORDER BY tp.updated_at DESC
            LIMIT 1
          )
        WHERE EXISTS (
          SELECT 1
          FROM turn_parts tp
          WHERE tp.part_type = 'turn_summary'
            AND tp.summary_turn_id = turns.id
        )
          AND turns.estimator_version IS NULL;

        DELETE FROM turns
        WHERE id LIKE 'summary-%'
           OR id LIKE 'summary-turn-%';
        ",
    )
    .map_err(|error| db_error("Could not migrate legacy Wizzle turn summaries", error))?;

    Ok(())
}

fn ensure_turn_part_columns(conn: &Connection) -> Result<(), String> {
    if table_column_is_not_null(conn, "turn_parts", "content")? {
        rebuild_turn_parts_for_nullable_content(conn)?;
        normalize_turn_part_anchor_rows(conn)?;
        return Ok(());
    }

    let columns = [
        ("message_id", "TEXT NULL"),
        ("tool_name", "TEXT NULL"),
        ("tool_arguments", "TEXT NULL"),
        ("tool_output", "TEXT NULL"),
        ("tool_error", "TEXT NULL"),
        ("assistant_phase", "TEXT NULL"),
        ("started_at", "INTEGER NULL"),
        ("completed_at", "INTEGER NULL"),
        ("duration_ms", "INTEGER NULL"),
        ("edited_at", "INTEGER NULL"),
        ("summary_turn_id", "TEXT NULL"),
        ("summary_message_ids", "TEXT NULL"),
        ("estimated_tokens_image_capable", "INTEGER NULL"),
        ("estimated_tokens_text_only", "INTEGER NULL"),
        ("estimator_version", "INTEGER NULL"),
        ("replay_message_count_image_capable", "INTEGER NULL"),
        ("replay_message_count_text_only", "INTEGER NULL"),
    ];

    for (column_name, column_type) in columns {
        if !table_has_column(conn, "turn_parts", column_name)? {
            conn.execute(
                &format!("ALTER TABLE turn_parts ADD COLUMN {column_name} {column_type}"),
                [],
            )
            .map_err(|error| db_error("Could not update Wizzle turn part metadata", error))?;
        }
    }

    normalize_turn_part_anchor_rows(conn)?;
    Ok(())
}

fn normalize_turn_part_anchor_rows(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "
        UPDATE turn_parts
        SET content = NULL
        WHERE part_type = 'message'
          AND role IN ('assistant', 'tool')
          AND message_id IS NOT NULL
          AND content IS NOT NULL
        ",
        [],
    )
    .map_err(|error| db_error("Could not normalize Wizzle message anchor rows", error))?;

    Ok(())
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn i64_to_bool(value: i64) -> bool {
    value != 0
}

fn row_to_process_payload(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceProcessPayload> {
    let started_at_ms = row.get::<_, i64>(6)?.max(0) as u64;
    let ended_at_ms = row
        .get::<_, Option<i64>>(7)?
        .map(|value| value.max(0) as u64);

    Ok(WorkspaceProcessPayload {
        command: row.get(2)?,
        cwd: row.get(3)?,
        ended_at_ms,
        exit_code: row.get(5)?,
        id: row.get(0)?,
        pid: row.get(4)?,
        session_id: row.get(1)?,
        started_at_ms,
        status: row.get(8)?,
        stderr_tail: row.get(10)?,
        stdout_tail: row.get(9)?,
        tool_call_id: row.get(12)?,
        turn_id: row.get(11)?,
    })
}

fn process_select_sql() -> &'static str {
    "
    SELECT id, session_id, command, cwd, pid, exit_code, started_at, ended_at,
           status, stdout_tail, stderr_tail, turn_id, tool_call_id
    FROM processes
    "
}

pub fn mark_orphaned_processes_on_startup() -> Result<(), String> {
    let conn = open_database()?;
    let timestamp = now_unix_ms();

    conn.execute(
        "
        UPDATE processes
        SET status = 'error',
            ended_at = COALESCE(ended_at, ?1),
            stderr_tail = CASE
              WHEN stderr_tail = '' THEN 'Process was still running when Wizzle last closed.'
              ELSE stderr_tail
            END
        WHERE status = 'running'
        ",
        params![timestamp as i64],
    )
    .map_err(|error| db_error("Could not mark old Wizzle processes as stopped", error))?;

    Ok(())
}

pub fn insert_process(record: NewProcessRecord) -> Result<WorkspaceProcessPayload, String> {
    validate_storage_id("session", &record.session_id)?;
    validate_storage_id("process", &record.id)?;
    if let Some(turn_id) = record.turn_id.as_deref() {
        validate_storage_id("turn", turn_id)?;
    }
    // Tool call ids may include underscores (provider ids); same alphabet as storage ids.
    if let Some(tool_call_id) = record.tool_call_id.as_deref() {
        validate_storage_id("tool call", tool_call_id)?;
    }
    let conn = open_database()?;
    ensure_process_link_columns(&conn)?;

    conn.execute(
        "
        INSERT INTO processes (
          id, session_id, command, cwd, pid, status, exit_code, started_at,
          ended_at, stdout_tail, stderr_tail, turn_id, tool_call_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, NULL, '', '', ?8, ?9)
        ",
        params![
            record.id,
            record.session_id,
            record.command,
            record.cwd,
            record.pid.map(|pid| pid as i64),
            record.status,
            record.started_at_ms as i64,
            record.turn_id,
            record.tool_call_id,
        ],
    )
    .map_err(|error| db_error("Could not record the Wizzle process", error))?;

    read_process(&record.session_id, &record.id)
}

pub fn update_process_tails(
    process_id: &str,
    stdout_chunk: &str,
    stderr_chunk: &str,
) -> Result<WorkspaceProcessPayload, String> {
    validate_storage_id("process", process_id)?;
    let conn = open_database()?;
    let (session_id, stdout_tail, stderr_tail): (String, String, String) = conn
        .query_row(
            "
            SELECT session_id, stdout_tail, stderr_tail
            FROM processes
            WHERE id = ?1
            ",
            params![process_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| db_error("Could not read Wizzle process output", error))?
        .ok_or_else(|| "Could not find that Wizzle process.".to_string())?;
    let next_stdout_tail = append_tail(&stdout_tail, stdout_chunk, PROCESS_TAIL_BYTES);
    let next_stderr_tail = append_tail(&stderr_tail, stderr_chunk, PROCESS_TAIL_BYTES);

    conn.execute(
        "
        UPDATE processes
        SET stdout_tail = ?1,
            stderr_tail = ?2
        WHERE id = ?3
        ",
        params![next_stdout_tail, next_stderr_tail, process_id],
    )
    .map_err(|error| db_error("Could not update Wizzle process output", error))?;

    read_process(&session_id, process_id)
}

pub fn finish_process(
    process_id: &str,
    status: &str,
    exit_code: Option<i64>,
) -> Result<WorkspaceProcessPayload, String> {
    validate_storage_id("process", process_id)?;
    let conn = open_database()?;
    let timestamp = now_unix_ms();
    let session_id = conn
        .query_row(
            "SELECT session_id FROM processes WHERE id = ?1",
            params![process_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| db_error("Could not read Wizzle process", error))?
        .ok_or_else(|| "Could not find that Wizzle process.".to_string())?;

    conn.execute(
        "
        UPDATE processes
        SET status = ?1,
            exit_code = ?2,
            ended_at = ?3
        WHERE id = ?4
          AND status = 'running'
        ",
        params![status, exit_code, timestamp as i64, process_id],
    )
    .map_err(|error| db_error("Could not finish Wizzle process tracking", error))?;

    read_process(&session_id, process_id)
}

pub fn mark_process_interrupted(
    session_id: &str,
    process_id: &str,
) -> Result<WorkspaceProcessPayload, String> {
    validate_storage_id("session", session_id)?;
    validate_storage_id("process", process_id)?;
    let conn = open_database()?;
    let timestamp = now_unix_ms();

    conn.execute(
        "
        UPDATE processes
        SET status = 'interrupted',
            ended_at = COALESCE(ended_at, ?1)
        WHERE id = ?2
          AND session_id = ?3
          AND status IN ('pending', 'running')
        ",
        params![timestamp as i64, process_id, session_id],
    )
    .map_err(|error| db_error("Could not stop Wizzle process tracking", error))?;

    read_process(session_id, process_id)
}

pub fn list_processes(session_id: &str) -> Result<Vec<WorkspaceProcessPayload>, String> {
    validate_storage_id("session", session_id)?;
    let conn = open_database()?;
    let mut statement = conn
        .prepare(&format!(
            "{} WHERE session_id = ?1 ORDER BY started_at DESC",
            process_select_sql()
        ))
        .map_err(|error| db_error("Could not prepare Wizzle process listing", error))?;
    let rows = statement
        .query_map(params![session_id], row_to_process_payload)
        .map_err(|error| db_error("Could not list Wizzle processes", error))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not read Wizzle process records", error))
}

pub fn read_process(session_id: &str, process_id: &str) -> Result<WorkspaceProcessPayload, String> {
    validate_storage_id("session", session_id)?;
    validate_storage_id("process", process_id)?;
    let conn = open_database()?;

    conn.query_row(
        &format!("{} WHERE session_id = ?1 AND id = ?2", process_select_sql()),
        params![session_id, process_id],
        row_to_process_payload,
    )
    .optional()
    .map_err(|error| db_error("Could not read Wizzle process", error))?
    .ok_or_else(|| "Could not find that Wizzle process.".to_string())
}

fn read_settings(conn: &Connection) -> Result<StoredSettingsFile, String> {
    let settings = conn
        .query_row(
            "
            SELECT is_file_panel_open, is_sidebar_open, model_id, permission_mode,
                   selected_project_id, selected_session_id
            FROM workspace_settings
            WHERE id = 1
            ",
            [],
            |row| {
                Ok(StoredSettingsFile {
                    is_file_panel_open: i64_to_bool(row.get::<_, i64>(0)?),
                    is_sidebar_open: i64_to_bool(row.get::<_, i64>(1)?),
                    model_id: row.get(2)?,
                    permission_mode: row.get(3)?,
                    selected_project_id: row.get(4)?,
                    selected_session_id: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|error| db_error("Could not read Wizzle settings", error))?;

    Ok(settings.unwrap_or_default())
}

fn write_settings(conn: &Connection, settings: &StoredSettingsFile) -> Result<(), String> {
    conn.execute(
        "
        INSERT INTO workspace_settings (
          id,
          is_file_panel_open,
          is_sidebar_open,
          model_id,
          permission_mode,
          selected_project_id,
          selected_session_id
        ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(id) DO UPDATE SET
          is_file_panel_open = excluded.is_file_panel_open,
          is_sidebar_open = excluded.is_sidebar_open,
          model_id = excluded.model_id,
          permission_mode = excluded.permission_mode,
          selected_project_id = excluded.selected_project_id,
          selected_session_id = excluded.selected_session_id
        ",
        params![
            bool_to_i64(settings.is_file_panel_open),
            bool_to_i64(settings.is_sidebar_open),
            settings.model_id,
            settings.permission_mode,
            settings.selected_project_id,
            settings.selected_session_id
        ],
    )
    .map_err(|error| db_error("Could not save Wizzle settings", error))?;

    Ok(())
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
    let input = record.input;
    WorkspaceMessageStepPayload {
        content: record.content,
        created_at_ms: record.created_at_ms,
        duration_ms: record.duration_ms,
        error: record.error,
        id: record.id,
        input: input.clone(),
        metadata: record.metadata,
        name: record.name,
        output: record.output,
        parent_part_id: record.parent_part_id,
        pruned: record.pruned,
        status: record.status,
        tokens: record.tokens,
        tool_arguments: input,
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

fn is_incomplete_lifecycle_status(status: Option<&str>) -> bool {
    matches!(status, Some("streaming" | "pending" | "running"))
}

/// Crash/reload recovery (#8 / #68): unfinished work becomes `interrupted`, never `done`.
/// Covers streaming, pending, and running message/part/tool statuses (not only streaming).
fn recover_incomplete_message(mut record: StoredMessageRecord) -> StoredMessageRecord {
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
        // Historical settle bug left user anchors as interrupted/error (#9); repair on load.
        if record.role == "user"
            && matches!(record.status.as_deref(), Some("interrupted" | "error"))
        {
            record.status = Some("done".to_string());
        }
        return record;
    }

    // User prompts were accepted; never leave them non-done after crash recovery.
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
        || record.parts.iter().any(|part| {
            matches!(part.r#type.as_str(), "content" | "activity_content")
                && part
                    .content
                    .as_ref()
                    .is_some_and(|value| !value.trim().is_empty())
        });

    // Keep any partial text; only inject fallback when the assistant is empty.
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
            // Terminal error parts stay error; other open work becomes interrupted.
            if part.status.as_deref() != Some("error") {
                part.status = Some("interrupted".to_string());
            }
        }
    }

    for tool_call in &mut record.tool_calls {
        if (is_incomplete_lifecycle_status(tool_call.status.as_deref())
            || (message_incomplete && tool_call.status.is_none()))
            && tool_call.status.as_deref() != Some("error")
        {
            tool_call.status = Some("interrupted".to_string());
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

fn normalize_message_record(record: StoredMessageRecord) -> StoredMessageRecord {
    recover_incomplete_message(record)
}

/// Cold-load recovery (#68): a process restart cannot continue in-flight turns.
fn interrupt_running_turns_on_load(conn: &Connection, session_id: &str) -> Result<(), String> {
    let now = now_unix_ms() as i64;
    conn.execute(
        "
        UPDATE turns
        SET status = 'interrupted',
            updated_at = MAX(updated_at, ?1)
        WHERE session_id = ?2
          AND status = 'running'
        ",
        params![now, session_id],
    )
    .map_err(|error| db_error("Could not recover running Wizzle turns on load", error))?;
    Ok(())
}

fn derive_legacy_steps(record: &StoredMessageRecord) -> Vec<StoredMessageStepRecord> {
    let mut steps = Vec::new();

    for tool_call in &record.tool_calls {
        let tool_call_part_id = format!("{}-tool-call-{}", record.id, tool_call.id);
        steps.push(StoredMessageStepRecord {
            created_at_ms: record.started_at_ms.or(Some(record.created_at)),
            id: tool_call_part_id.clone(),
            input: tool_call.input.clone(),
            name: Some(tool_call.name.clone()),
            // tool_call parents the assistant message anchor.
            parent_part_id: Some(record.id.clone()),
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
                parent_part_id: Some(tool_call_part_id.clone()),
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
    session_root: &Path,
    record: &StoredAttachmentRecord,
) -> Result<AttachmentPreviewPayload, String> {
    let absolute_path = if record.relative_path.is_empty() {
        record
            .original_path
            .as_ref()
            .map(PathBuf::from)
            .ok_or_else(|| "Could not resolve the attachment source path.".to_string())?
    } else {
        session_root.join(&record.relative_path)
    };

    let mut payload = AttachmentPreviewPayload {
        content: None,
        content_hash: record.content_hash.clone(),
        error: None,
        id: record.id.clone(),
        image_src: None,
        is_sensitive: None,
        kind: record.kind.clone(),
        language: record.language.clone(),
        mime_type: record.mime_type.clone(),
        name: record.name.clone(),
        original_path: record.original_path.clone(),
        path: absolute_path.to_string_lossy().to_string(),
        preview_metadata: record.preview_metadata.clone(),
        real_path: record.real_path.clone(),
        size_bytes: record.size_bytes,
        summary: record.summary.clone(),
    };

    match record.kind.as_str() {
        "image" => {
            let bytes = fs::read(&absolute_path).map_err(|error| {
                io_error(
                    &format!("Could not read attachment {}", absolute_path.display()),
                    error,
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
                io_error(
                    &format!("Could not read attachment {}", absolute_path.display()),
                    error,
                )
            })?);
        }
    }

    Ok(payload)
}

fn to_workspace_message(
    session_root: &Path,
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
            .or_insert(load_attachment_preview(session_root, attachment)?);
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
        reasoning: None,
        reasoning_duration_ms: None,
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

fn build_workspace_session_summary(metadata: StoredSessionMetadata) -> WorkspaceSessionPayload {
    WorkspaceSessionPayload {
        created_at_ms: metadata.created_at,
        id: metadata.id,
        messages: Vec::new(),
        messages_loaded: false,
        model_id: metadata.model_id,
        permission_mode: metadata.permission_mode,
        compacted_context: metadata.compacted_context,
        replay_turn_summaries: Vec::new(),
        selected_model_uuid: metadata.selected_model_uuid,
        system_prompt_hash: metadata.system_prompt_hash,
        tokenizer_kind: metadata.tokenizer_kind,
        tool_def_tokens: metadata.tool_def_tokens,
        tool_defs_hash: metadata.tool_defs_hash,
        title: metadata.title,
        updated_at_label: compact_time_label(metadata.updated_at),
        updated_at_ms: metadata.updated_at,
    }
}

fn read_project(
    conn: &Connection,
    project_id: &str,
) -> Result<Option<StoredProjectRecord>, String> {
    conn.query_row(
        "SELECT id, name, path, is_expanded, created_at, updated_at FROM projects WHERE id = ?1",
        params![project_id],
        |row| {
            Ok(StoredProjectRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                is_expanded: i64_to_bool(row.get::<_, i64>(3)?),
                created_at: row.get::<_, i64>(4)? as u64,
                updated_at: row.get::<_, i64>(5)? as u64,
            })
        },
    )
    .optional()
    .map_err(|error| db_error("Could not read the Wizzle project", error))
}

fn read_projects(conn: &Connection) -> Result<Vec<StoredProjectRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, name, path, is_expanded, created_at, updated_at
             FROM projects
             ORDER BY updated_at DESC, created_at DESC",
        )
        .map_err(|error| db_error("Could not prepare the Wizzle project query", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(StoredProjectRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                is_expanded: i64_to_bool(row.get::<_, i64>(3)?),
                created_at: row.get::<_, i64>(4)? as u64,
                updated_at: row.get::<_, i64>(5)? as u64,
            })
        })
        .map_err(|error| db_error("Could not read Wizzle projects", error))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not parse Wizzle projects", error))
}

fn read_session_metadata(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<StoredSessionMetadata>, String> {
    conn.query_row(
        "
        SELECT
          id, project_id, title, selected_model_uuid, model_id, permission_mode, created_at, updated_at,
          system_prompt_hash, tokenizer_kind, tool_def_tokens, tool_defs_hash,
          last_compacted_summary, last_compacted_tokens, last_compacted_at
        FROM sessions
        WHERE id = ?1
        ",
        params![session_id],
        |row| {
            Ok(StoredSessionMetadata {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                model_id: row
                    .get::<_, Option<String>>(3)?
                    .or(row.get::<_, Option<String>>(4)?),
                permission_mode: row.get(5)?,
                created_at: row.get::<_, i64>(6)? as u64,
                updated_at: row.get::<_, i64>(7)? as u64,
                selected_model_uuid: row.get(3)?,
                system_prompt_hash: row.get(8)?,
                tokenizer_kind: row.get(9)?,
                tool_def_tokens: row.get::<_, i64>(10).ok().map(|value| value.max(0) as u64),
                tool_defs_hash: row.get(11)?,
                compacted_context: read_compacted_context_from_row(row, 12, 13, 14)?,
            })
        },
    )
    .optional()
    .map_err(|error| db_error("Could not read the Wizzle session", error))
}

fn load_project_sessions(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<WorkspaceSessionPayload>, String> {
    let mut statement = conn
        .prepare(
            "
            SELECT
              id, project_id, title, selected_model_uuid, model_id, permission_mode, created_at, updated_at,
              system_prompt_hash, tokenizer_kind, tool_def_tokens, tool_defs_hash,
              last_compacted_summary, last_compacted_tokens, last_compacted_at
            FROM sessions
            WHERE project_id = ?1
            ORDER BY updated_at DESC, created_at DESC
            ",
        )
        .map_err(|error| db_error("Could not prepare the Wizzle session query", error))?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok(StoredSessionMetadata {
                id: row.get(0)?,
                project_id: row.get(1)?,
                title: row.get(2)?,
                model_id: row
                    .get::<_, Option<String>>(3)?
                    .or(row.get::<_, Option<String>>(4)?),
                permission_mode: row.get(5)?,
                created_at: row.get::<_, i64>(6)? as u64,
                updated_at: row.get::<_, i64>(7)? as u64,
                selected_model_uuid: row.get(3)?,
                system_prompt_hash: row.get(8)?,
                tokenizer_kind: row.get(9)?,
                tool_def_tokens: row.get::<_, i64>(10).ok().map(|value| value.max(0) as u64),
                tool_defs_hash: row.get(11)?,
                compacted_context: read_compacted_context_from_row(row, 12, 13, 14)?,
            })
        })
        .map_err(|error| db_error("Could not read Wizzle sessions", error))?;

    let metadata = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not parse Wizzle sessions", error))?;

    Ok(metadata
        .into_iter()
        .map(build_workspace_session_summary)
        .collect())
}

fn load_attachment_records(
    conn: &Connection,
    turn_part_id: &str,
) -> Result<Vec<StoredAttachmentRecord>, String> {
    let mut statement = conn
        .prepare(
            "
            SELECT preview
            FROM files
            WHERE turn_part_id = ?1
            ORDER BY created_at ASC, id ASC
            ",
        )
        .map_err(|error| db_error("Could not prepare Wizzle attachment loading", error))?;
    let rows = statement
        .query_map(params![turn_part_id], |row| row.get::<_, String>(0))
        .map_err(|error| db_error("Could not read Wizzle attachments", error))?;

    rows.map(|row| {
        let preview =
            row.map_err(|error| db_error("Could not parse a Wizzle attachment row", error))?;
        serde_json::from_str::<StoredAttachmentRecord>(&preview)
            .map_err(|error| format!("Could not parse saved Wizzle attachment metadata: {error}"))
    })
    .collect()
}

fn load_session_history(
    conn: &Connection,
    session_id: &str,
) -> Result<(Vec<StoredMessageRecord>, Vec<StoredTurnSummaryRecord>), String> {
    #[derive(Default)]
    struct TurnPartRow {
        assistant_phase: Option<String>,
        completed_at: Option<u64>,
        content: Option<String>,
        created_at: u64,
        duration_ms: Option<u64>,
        edited_at: Option<u64>,
        error: Option<String>,
        estimated_tokens_image_capable: Option<u64>,
        estimated_tokens_text_only: Option<u64>,
        estimator_version: Option<u32>,
        id: String,
        message_id: Option<String>,
        metadata: Option<Value>,
        parent_part_id: Option<String>,
        part_type: String,
        pruned: Option<bool>,
        replay_message_count_image_capable: Option<u64>,
        replay_message_count_text_only: Option<u64>,
        role: String,
        started_at: Option<u64>,
        status: Option<String>,
        summary_message_ids: Option<String>,
        summary_turn_id: Option<String>,
        tokens: Option<u64>,
        tool_arguments: Option<String>,
        tool_call_id: Option<String>,
        tool_name: Option<String>,
        tool_output: Option<String>,
        turn_id: String,
        updated_at: u64,
    }

    fn optional_i64_to_u64(value: Option<i64>) -> Option<u64> {
        value.map(|entry| entry.max(0) as u64)
    }

    fn metadata_message_id(metadata: &Option<Value>) -> Option<String> {
        metadata
            .as_ref()
            .and_then(Value::as_object)
            .and_then(|object| object.get("messageId"))
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    fn row_to_step(row: &TurnPartRow) -> StoredMessageStepRecord {
        StoredMessageStepRecord {
            content: row.content.clone(),
            created_at_ms: Some(row.created_at),
            duration_ms: row.duration_ms,
            error: row.error.clone(),
            id: row.id.clone(),
            input: row.tool_arguments.clone(),
            metadata: row.metadata.clone(),
            name: row.tool_name.clone(),
            output: row.tool_output.clone(),
            parent_part_id: row.parent_part_id.clone(),
            pruned: row.pruned,
            status: row.status.clone(),
            tokens: row.tokens,
            tool_call_id: row.tool_call_id.clone(),
            r#type: row.part_type.clone(),
        }
    }

    fn normalize_loaded_message_from_parts(message: &mut StoredMessageRecord) {
        if message.parts.is_empty() {
            return;
        }

        match message.role.as_str() {
            "assistant" => {
                // Include activity_content so reload keeps pre-tool assistant text
                // on the message anchor (matches frontend synchronizeMessageFromParts).
                message.content = message
                    .parts
                    .iter()
                    .filter(|part| part.r#type == "content" || part.r#type == "activity_content")
                    .filter_map(|part| part.content.clone())
                    .collect::<Vec<_>>()
                    .join("");
                message.tool_calls = message
                    .parts
                    .iter()
                    .filter(|part| part.r#type == "tool_call")
                    .filter_map(|part| {
                        Some(StoredToolCallRecord {
                            id: part.tool_call_id.clone().unwrap_or_else(|| part.id.clone()),
                            input: part.input.clone(),
                            name: part.name.clone()?,
                            status: part.status.clone(),
                        })
                    })
                    .collect();
                message.tool_results = message
                    .parts
                    .iter()
                    .filter(|part| part.r#type == "tool_result")
                    .map(|part| StoredToolResultRecord {
                        error: part.error.clone(),
                        id: part.id.clone(),
                        output: part.output.clone(),
                        status: part.status.clone(),
                        tool_call_id: part.tool_call_id.clone(),
                    })
                    .collect();
            }
            "tool" => {
                if let Some(part) = message
                    .parts
                    .iter()
                    .find(|part| part.r#type == "tool_result")
                {
                    message.content = part
                        .output
                        .clone()
                        .or_else(|| part.error.clone())
                        .unwrap_or_default();
                    message.tool_call_id =
                        part.tool_call_id.clone().or(message.tool_call_id.clone());
                    message.tool_name = part.name.clone().or(message.tool_name.clone());
                }
            }
            _ => {}
        }

        // Same recovery as JSON/legacy load: never promote unfinished work to done (#8/#68).
        *message = recover_incomplete_message(std::mem::take(message));
    }

    fn parse_summary_message_ids(raw_value: Option<String>) -> Result<Vec<String>, String> {
        let Some(raw_value) = raw_value.filter(|value| !value.trim().is_empty()) else {
            return Ok(Vec::new());
        };

        serde_json::from_str::<Vec<String>>(&raw_value)
            .map_err(|error| format!("Could not parse saved Wizzle summary message ids: {error}"))
    }

    let mut statement = conn
        .prepare(
            "
            SELECT
              turns.id,
              turn_parts.id,
              turn_parts.role,
              turn_parts.part_type,
              turn_parts.content,
              turn_parts.tokens,
              turn_parts.metadata,
              turn_parts.status,
              turn_parts.parent_part_id,
              turn_parts.tool_call_id,
              turn_parts.pruned,
              turn_parts.created_at,
              turn_parts.updated_at,
              turn_parts.message_id,
              turn_parts.tool_name,
              turn_parts.tool_arguments,
              turn_parts.tool_output,
              turn_parts.tool_error,
              turn_parts.assistant_phase,
              turn_parts.started_at,
              turn_parts.completed_at,
              turn_parts.duration_ms,
              turn_parts.edited_at,
              turn_parts.summary_turn_id,
              turn_parts.summary_message_ids,
              turn_parts.estimated_tokens_image_capable,
              turn_parts.estimated_tokens_text_only,
              turn_parts.estimator_version,
              turn_parts.replay_message_count_image_capable,
              turn_parts.replay_message_count_text_only
            FROM turns
            JOIN turn_parts ON turn_parts.turn_id = turns.id
            WHERE turns.session_id = ?1
            ORDER BY turns.turn_index ASC, turn_parts.part_index ASC
            ",
        )
        .map_err(|error| db_error("Could not prepare the Wizzle transcript query", error))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            let metadata = row
                .get::<_, Option<String>>(6)?
                .and_then(|raw_value| serde_json::from_str::<Value>(&raw_value).ok());
            Ok(TurnPartRow {
                turn_id: row.get(0)?,
                id: row.get(1)?,
                role: row.get(2)?,
                part_type: row.get(3)?,
                content: row.get(4)?,
                tokens: optional_i64_to_u64(row.get(5)?),
                metadata,
                status: row.get(7)?,
                parent_part_id: row.get(8)?,
                tool_call_id: row.get(9)?,
                pruned: Some(i64_to_bool(row.get::<_, i64>(10)?)),
                created_at: row.get::<_, i64>(11)?.max(0) as u64,
                updated_at: row.get::<_, i64>(12)?.max(0) as u64,
                message_id: row.get(13)?,
                tool_name: row.get(14)?,
                tool_arguments: row.get(15)?,
                tool_output: row.get(16)?,
                error: row.get(17)?,
                assistant_phase: row.get(18)?,
                started_at: optional_i64_to_u64(row.get(19)?),
                completed_at: optional_i64_to_u64(row.get(20)?),
                duration_ms: optional_i64_to_u64(row.get(21)?),
                edited_at: optional_i64_to_u64(row.get(22)?),
                summary_turn_id: row.get(23)?,
                summary_message_ids: row.get(24)?,
                estimated_tokens_image_capable: optional_i64_to_u64(row.get(25)?),
                estimated_tokens_text_only: optional_i64_to_u64(row.get(26)?),
                estimator_version: row
                    .get::<_, Option<i64>>(27)?
                    .map(|value| value.max(0) as u32),
                replay_message_count_image_capable: optional_i64_to_u64(row.get(28)?),
                replay_message_count_text_only: optional_i64_to_u64(row.get(29)?),
            })
        })
        .map_err(|error| db_error("Could not read the Wizzle transcript", error))?;

    let mut message_order = Vec::new();
    let mut messages = BTreeMap::new();
    let mut summaries = Vec::new();

    for row in rows {
        let row =
            row.map_err(|error| db_error("Could not parse a Wizzle transcript row", error))?;

        if row.part_type == "message" {
            let message = if row.message_id.is_none() {
                row.content
                    .as_deref()
                    .and_then(|content| serde_json::from_str::<StoredMessageRecord>(content).ok())
            } else {
                None
            }
            .unwrap_or_else(|| StoredMessageRecord {
                assistant_phase: row.assistant_phase.clone(),
                completed_at_ms: row.completed_at,
                content: if row.role == "user" {
                    row.content.clone().unwrap_or_default()
                } else {
                    String::new()
                },
                created_at: row.created_at,
                duration_ms: row.duration_ms,
                edited_at_ms: row.edited_at,
                id: row.message_id.clone().unwrap_or_else(|| row.id.clone()),
                linked_file_ids: Vec::new(),
                reasoning: None,
                reasoning_duration_ms: None,
                attachments: Vec::new(),
                role: row.role.clone(),
                tool_call_id: row.tool_call_id.clone(),
                tool_name: row.tool_name.clone(),
                turn_id: Some(row.turn_id.clone()),
                started_at_ms: row.started_at,
                status: row.status.clone(),
                parts: Vec::new(),
                tool_calls: Vec::new(),
                tool_results: Vec::new(),
            });
            message_order.push(message.id.clone());
            messages.insert(message.id.clone(), message);
            continue;
        }

        if row.part_type == "turn_summary" {
            if row.summary_turn_id.is_none() {
                if let Some(summary) = row.content.as_deref().and_then(|content| {
                    serde_json::from_str::<StoredTurnSummaryRecord>(content).ok()
                }) {
                    summaries.push(summary);
                }
                continue;
            }

            summaries.push(StoredTurnSummaryRecord {
                completed_at_ms: row.completed_at.unwrap_or(row.updated_at),
                estimated_tokens_image_capable: row.estimated_tokens_image_capable.unwrap_or(0),
                estimated_tokens_text_only: row.estimated_tokens_text_only.unwrap_or(0),
                estimator_version: row.estimator_version.unwrap_or(0),
                message_ids: parse_summary_message_ids(row.summary_message_ids.clone())?,
                replay_message_count_image_capable: row
                    .replay_message_count_image_capable
                    .unwrap_or(0),
                replay_message_count_text_only: row.replay_message_count_text_only.unwrap_or(0),
                turn_id: row.summary_turn_id.clone().unwrap_or_default(),
            });
            continue;
        }

        let Some(message_id) = row
            .message_id
            .clone()
            .or_else(|| metadata_message_id(&row.metadata))
        else {
            continue;
        };
        let Some(message) = messages.get_mut(&message_id) else {
            continue;
        };

        if message.parts.iter().any(|part| part.id == row.id) {
            continue;
        }

        message.parts.push(row_to_step(&row));
    }

    for message_id in &message_order {
        if let Some(message) = messages.get_mut(message_id) {
            let attachments = load_attachment_records(conn, message_id)?;
            message.linked_file_ids = attachments
                .iter()
                .map(|attachment| attachment.id.clone())
                .collect();
            message.attachments = attachments;
            normalize_loaded_message_from_parts(message);
        }
    }

    // Prefer budget columns on real turns (#71); keep any legacy part-based summaries as fallback.
    let mut summary_by_turn = std::collections::HashMap::<String, StoredTurnSummaryRecord>::new();
    for summary in summaries {
        if !summary.turn_id.is_empty() {
            summary_by_turn.insert(summary.turn_id.clone(), summary);
        }
    }
    for summary in load_turn_budget_summaries(conn, session_id)? {
        summary_by_turn.insert(summary.turn_id.clone(), summary);
    }
    let mut merged_summaries = summary_by_turn.into_values().collect::<Vec<_>>();
    merged_summaries.sort_by(|left, right| left.turn_id.cmp(&right.turn_id));

    Ok((
        message_order
            .into_iter()
            .filter_map(|message_id| messages.remove(&message_id))
            .collect(),
        merged_summaries,
    ))
}

fn load_turn_budget_summaries(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<StoredTurnSummaryRecord>, String> {
    if !table_has_column(conn, "turns", "estimator_version")? {
        return Ok(Vec::new());
    }

    let mut statement = conn
        .prepare(
            "
            SELECT
              id,
              estimated_tokens_image_capable,
              estimated_tokens_text_only,
              estimator_version,
              replay_message_count_image_capable,
              replay_message_count_text_only,
              summary_message_ids,
              summary_completed_at,
              updated_at
            FROM turns
            WHERE session_id = ?1
              AND estimator_version IS NOT NULL
              AND id NOT LIKE 'summary-%'
            ORDER BY turn_index ASC
            ",
        )
        .map_err(|error| db_error("Could not prepare turn budget loading", error))?;

    let rows = statement
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|error| db_error("Could not read turn budget rows", error))?;

    let mut summaries = Vec::new();
    for row in rows {
        let (
            turn_id,
            estimated_tokens_image_capable,
            estimated_tokens_text_only,
            estimator_version,
            replay_message_count_image_capable,
            replay_message_count_text_only,
            summary_message_ids,
            summary_completed_at,
            updated_at,
        ) = row.map_err(|error| db_error("Could not parse turn budget row", error))?;

        let Some(estimator_version) = estimator_version else {
            continue;
        };

        let message_ids = parse_summary_message_ids_value(summary_message_ids)?;
        summaries.push(StoredTurnSummaryRecord {
            completed_at_ms: summary_completed_at
                .map(|value| value.max(0) as u64)
                .unwrap_or_else(|| updated_at.max(0) as u64),
            estimated_tokens_image_capable: estimated_tokens_image_capable.unwrap_or(0).max(0)
                as u64,
            estimated_tokens_text_only: estimated_tokens_text_only.unwrap_or(0).max(0) as u64,
            estimator_version: estimator_version.max(0) as u32,
            message_ids,
            replay_message_count_image_capable: replay_message_count_image_capable
                .unwrap_or(0)
                .max(0) as u64,
            replay_message_count_text_only: replay_message_count_text_only.unwrap_or(0).max(0)
                as u64,
            turn_id,
        });
    }

    Ok(summaries)
}

fn parse_summary_message_ids_value(raw_value: Option<String>) -> Result<Vec<String>, String> {
    let Some(raw_value) = raw_value.filter(|value| !value.trim().is_empty()) else {
        return Ok(Vec::new());
    };

    serde_json::from_str::<Vec<String>>(&raw_value)
        .map_err(|error| format!("Could not parse saved Wizzle summary message ids: {error}"))
}

fn load_workspace_session_payload(
    conn: &Connection,
    session_id: &str,
    preview_files: &mut BTreeMap<String, AttachmentPreviewPayload>,
) -> Result<WorkspaceSessionPayload, String> {
    validate_storage_id("session", session_id)?;
    let mut metadata = read_session_metadata(conn, session_id)?
        .ok_or_else(|| format!("Could not find session {session_id}."))?;
    if let Some(compacted_context) = metadata.compacted_context.as_mut() {
        compacted_context.compacted_turn_ids = read_compacted_turn_ids(conn, session_id)?;
    }
    // Cold load: in-flight agent state is gone — close stuck running turns (#68).
    interrupt_running_turns_on_load(conn, session_id)?;
    let (messages, summaries) = load_session_history(conn, session_id)?;
    let root = ensure_workspace_storage()?;
    let session_root = sqlite_session_dir(&root, session_id)?;

    let messages = messages
        .into_iter()
        .map(|message| to_workspace_message(&session_root, preview_files, message))
        .collect::<Result<Vec<_>, String>>()?;

    Ok(WorkspaceSessionPayload {
        created_at_ms: metadata.created_at,
        id: metadata.id,
        messages,
        messages_loaded: true,
        model_id: metadata.model_id,
        permission_mode: metadata.permission_mode,
        compacted_context: metadata.compacted_context,
        replay_turn_summaries: summaries
            .into_iter()
            .map(to_workspace_turn_summary)
            .collect(),
        selected_model_uuid: metadata.selected_model_uuid,
        system_prompt_hash: metadata.system_prompt_hash,
        tokenizer_kind: metadata.tokenizer_kind,
        tool_def_tokens: metadata.tool_def_tokens,
        tool_defs_hash: metadata.tool_defs_hash,
        title: metadata.title,
        updated_at_label: compact_time_label(metadata.updated_at),
        updated_at_ms: metadata.updated_at,
    })
}

fn resolve_valid_selected_project(
    projects: &[WorkspaceProjectPayload],
    selected_project_id: Option<String>,
) -> String {
    selected_project_id
        .filter(|project_id| projects.iter().any(|project| &project.id == project_id))
        .or_else(|| projects.first().map(|project| project.id.clone()))
        .unwrap_or_default()
}

fn resolve_valid_selected_session(
    projects: &[WorkspaceProjectPayload],
    selected_project_id: &str,
    selected_session_id: Option<String>,
) -> Option<String> {
    selected_session_id.filter(|session_id| {
        projects
            .iter()
            .find(|project| project.id == selected_project_id)
            .map(|project| {
                project
                    .sessions
                    .iter()
                    .any(|session| &session.id == session_id)
            })
            .unwrap_or(false)
    })
}

pub fn build_workspace_snapshot() -> Result<WorkspaceSnapshotPayload, String> {
    let conn = open_database()?;
    let settings = read_settings(&conn)?;
    let project_records = read_projects(&conn)?;
    let mut preview_files = BTreeMap::new();

    let mut projects = project_records
        .into_iter()
        .map(|project| {
            validate_storage_id("project", &project.id)?;
            Ok(WorkspaceProjectPayload {
                created_at_ms: project.created_at,
                id: project.id.clone(),
                is_expanded: project.is_expanded,
                name: project.name,
                root_path: project.root_path,
                sessions: load_project_sessions(&conn, &project.id)?,
                updated_at_ms: project.updated_at,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let selected_project_id =
        resolve_valid_selected_project(&projects, settings.selected_project_id.clone());
    let selected_session_id = resolve_valid_selected_session(
        &projects,
        &selected_project_id,
        settings.selected_session_id,
    );

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
                    &conn,
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
        "sqlite_snapshot_built",
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
    input: LoadWorkspaceSessionInput,
) -> Result<WorkspaceSessionLoadPayload, String> {
    validate_storage_id("project", &input.project_id)?;
    validate_storage_id("session", &input.session_id)?;
    let conn = open_database()?;
    let session = read_session_metadata(&conn, &input.session_id)?
        .filter(|session| session.project_id == input.project_id)
        .ok_or_else(|| format!("Could not find session {}.", input.session_id))?;
    let mut preview_files = BTreeMap::new();
    let payload = load_workspace_session_payload(&conn, &session.id, &mut preview_files)?;

    Ok(WorkspaceSessionLoadPayload {
        preview_files: preview_files.into_values().collect(),
        session: payload,
    })
}

pub fn load_composer_state(
    input: LoadComposerStateInput,
) -> Result<WorkspaceComposerStatePayload, String> {
    validate_storage_id("session", &input.session_id)?;
    let conn = open_database()?;
    load_composer_state_from_conn(&conn, &input.session_id)
}

fn load_composer_state_from_conn(
    conn: &Connection,
    session_id: &str,
) -> Result<WorkspaceComposerStatePayload, String> {
    let draft_text = conn
        .query_row(
            "SELECT draft_text FROM composer_drafts WHERE session_id = ?1",
            params![session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| db_error("Could not read the composer draft", error))?
        .unwrap_or_default();

    let mut statement = conn
        .prepare(
            "
            SELECT id, content, attachments_json, queue_index, status, created_at, updated_at
            FROM queued_messages
            WHERE session_id = ?1
            ORDER BY queue_index ASC, created_at ASC
            ",
        )
        .map_err(|error| db_error("Could not prepare queued message loading", error))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            let attachments_json: String = row.get(2)?;
            let attachments = serde_json::from_str::<Vec<PersistedPreviewFileInput>>(
                &attachments_json,
            )
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;

            Ok(WorkspaceQueuedMessagePayload {
                id: row.get(0)?,
                content: row.get(1)?,
                attachments,
                queue_index: row.get::<_, i64>(3)? as u64,
                status: row.get(4)?,
                created_at_ms: row.get::<_, i64>(5)? as u64,
                updated_at_ms: row.get::<_, i64>(6)? as u64,
            })
        })
        .map_err(|error| db_error("Could not read queued messages", error))?;
    let queued_messages = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not parse queued messages", error))?;

    Ok(WorkspaceComposerStatePayload {
        draft_text,
        queued_messages,
    })
}

pub fn save_composer_state(input: SaveComposerStateInput) -> Result<(), String> {
    validate_storage_id("session", &input.session_id)?;
    let mut conn = open_database()?;
    save_composer_state_with_conn(&mut conn, input)
}

fn save_composer_state_with_conn(
    conn: &mut Connection,
    input: SaveComposerStateInput,
) -> Result<(), String> {
    let timestamp = now_unix_ms();
    let tx = conn
        .transaction()
        .map_err(|error| db_error("Could not start composer state persistence", error))?;

    let session_exists = tx
        .query_row(
            "SELECT 1 FROM sessions WHERE id = ?1",
            params![input.session_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| db_error("Could not verify the composer session", error))?
        .is_some();

    if !session_exists {
        return Ok(());
    }

    if input.draft_text.trim().is_empty() {
        tx.execute(
            "DELETE FROM composer_drafts WHERE session_id = ?1",
            params![input.session_id],
        )
        .map_err(|error| db_error("Could not clear the composer draft", error))?;
    } else {
        tx.execute(
            "
            INSERT INTO composer_drafts (session_id, draft_text, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(session_id) DO UPDATE SET
              draft_text = excluded.draft_text,
              updated_at = excluded.updated_at
            ",
            params![input.session_id, input.draft_text, timestamp as i64],
        )
        .map_err(|error| db_error("Could not save the composer draft", error))?;
    }

    tx.execute(
        "DELETE FROM queued_messages WHERE session_id = ?1",
        params![input.session_id],
    )
    .map_err(|error| db_error("Could not replace queued messages", error))?;

    for (index, queued_message) in input.queued_messages.into_iter().enumerate() {
        insert_queued_message(&tx, &input.session_id, queued_message, index, timestamp)?;
    }

    tx.commit()
        .map_err(|error| db_error("Could not finish composer state persistence", error))
}

fn insert_queued_message(
    tx: &Transaction<'_>,
    session_id: &str,
    queued_message: PersistedQueuedMessageInput,
    index: usize,
    timestamp: u64,
) -> Result<(), String> {
    let attachments_json = serde_json::to_string(&queued_message.attachments)
        .map_err(|error| format!("Could not serialize queued attachments: {error}"))?;
    let status = queued_message
        .status
        .unwrap_or_else(|| "queued".to_string());

    tx.execute(
        "
        INSERT INTO queued_messages (
          id, session_id, content, attachments_json, queue_index, status, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
        ",
        params![
            queued_message.id,
            session_id,
            queued_message.content,
            attachments_json,
            index as i64,
            status,
            timestamp as i64
        ],
    )
    .map_err(|error| db_error("Could not save a queued message", error))?;

    Ok(())
}

pub fn add_project_from_path(root_path: &str) -> Result<WorkspaceSnapshotPayload, String> {
    let conn = open_database()?;
    let normalized_root_path = canonical_display_path(Path::new(root_path));
    let existing_project_id: Option<String> = conn
        .query_row(
            "SELECT id FROM projects WHERE path = ?1",
            params![normalized_root_path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| db_error("Could not check for an existing Wizzle project", error))?;

    if let Some(project_id) = existing_project_id {
        let mut settings = read_settings(&conn)?;
        settings.selected_project_id = Some(project_id);
        settings.selected_session_id = None;
        write_settings(&conn, &settings)?;
        return build_workspace_snapshot();
    }

    let timestamp = now_unix_ms();
    let project_id = new_project_id();
    let project_name = Path::new(&normalized_root_path)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(&normalized_root_path)
        .to_string();

    conn.execute(
        "
        INSERT INTO projects (id, name, path, is_expanded, created_at, updated_at)
        VALUES (?1, ?2, ?3, 1, ?4, ?4)
        ",
        params![
            project_id,
            project_name,
            normalized_root_path,
            timestamp as i64
        ],
    )
    .map_err(|error| db_error("Could not add the Wizzle project", error))?;

    let mut settings = read_settings(&conn)?;
    settings.selected_project_id = Some(project_id);
    settings.selected_session_id = None;
    write_settings(&conn, &settings)?;

    build_workspace_snapshot()
}

pub fn remove_project_by_id(project_id: &str) -> Result<WorkspaceSnapshotPayload, String> {
    validate_storage_id("project", project_id)?;
    let mut conn = open_database()?;
    let session_ids = read_session_ids_for_project(&conn, project_id)?;
    let quarantined = quarantine_session_directories(&session_ids)?;
    let deletion_result = (|| {
        let tx = conn
            .transaction()
            .map_err(|error| db_error("Could not start project removal", error))?;

        tx.execute("DELETE FROM projects WHERE id = ?1", params![project_id])
            .map_err(|error| db_error("Could not remove the Wizzle project", error))?;
        update_settings_after_project_delete(&tx, project_id)?;
        tx.commit()
            .map_err(|error| db_error("Could not finish project removal", error))
    })();

    if let Err(error) = deletion_result {
        return Err(restore_after_failed_deletion(error, &quarantined));
    }

    finalize_quarantined_deletion(&quarantined);
    build_workspace_snapshot()
}

fn read_session_ids_for_project(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare("SELECT id FROM sessions WHERE project_id = ?1")
        .map_err(|error| db_error("Could not prepare session cleanup", error))?;
    let rows = statement
        .query_map(params![project_id], |row| row.get::<_, String>(0))
        .map_err(|error| db_error("Could not read sessions for cleanup", error))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not parse sessions for cleanup", error))
}

fn update_settings_after_project_delete(
    tx: &Transaction<'_>,
    project_id: &str,
) -> Result<(), String> {
    let selected_project_id: Option<String> = tx
        .query_row(
            "SELECT selected_project_id FROM workspace_settings WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| db_error("Could not read Wizzle selection", error))?
        .flatten();

    if selected_project_id.as_deref() == Some(project_id) {
        tx.execute(
            "
            UPDATE workspace_settings
            SET selected_project_id = NULL,
                selected_session_id = NULL
            WHERE id = 1
            ",
            [],
        )
        .map_err(|error| db_error("Could not clear Wizzle selection", error))?;
    }

    Ok(())
}

struct QuarantinedSessionDirectory {
    original: PathBuf,
    quarantined: PathBuf,
    session_id: String,
}

fn quarantine_session_directories(
    session_ids: &[String],
) -> Result<Vec<QuarantinedSessionDirectory>, String> {
    let root = ensure_workspace_storage()?;
    let trash_root = root.join("sessions").join(".trash");
    let mut quarantined = Vec::new();

    for session_id in session_ids {
        let session_dir = sqlite_session_dir(&root, session_id)?;
        if !session_dir.exists() {
            continue;
        }

        ensure_dir(&trash_root)?;
        let trash_dir = trash_root.join(format!("{session_id}-{}", Uuid::new_v4()));
        if let Err(error) = fs::rename(&session_dir, &trash_dir) {
            let message = io_error(
                &format!("Could not prepare local files for deleting session {session_id}"),
                error,
            );
            return Err(restore_after_failed_deletion(message, &quarantined));
        }

        quarantined.push(QuarantinedSessionDirectory {
            original: session_dir,
            quarantined: trash_dir,
            session_id: session_id.clone(),
        });
    }

    Ok(quarantined)
}

fn restore_after_failed_deletion(
    error: String,
    quarantined: &[QuarantinedSessionDirectory],
) -> String {
    let mut restore_failures = Vec::new();
    for entry in quarantined.iter().rev() {
        if let Err(restore_error) = fs::rename(&entry.quarantined, &entry.original) {
            restore_failures.push(format!("{}: {restore_error}", entry.session_id));
        }
    }

    if restore_failures.is_empty() {
        error
    } else {
        format!(
            "{error} Local files could not be restored for: {}.",
            restore_failures.join(", ")
        )
    }
}

fn finalize_quarantined_deletion(quarantined: &[QuarantinedSessionDirectory]) {
    for entry in quarantined {
        if let Err(error) = fs::remove_dir_all(&entry.quarantined) {
            log_desktop_event(
                "error",
                "desktop.workspace",
                "session_file_cleanup_failed",
                json!({
                    "errorKind": error.kind().to_string(),
                    "sessionIdLength": entry.session_id.len(),
                }),
            );
        }
    }
}

pub fn save_workspace_settings(input: SaveWorkspaceSettingsInput) -> Result<(), String> {
    let conn = open_database()?;
    let settings = StoredSettingsFile {
        is_file_panel_open: input.is_file_panel_open,
        is_sidebar_open: input.is_sidebar_open,
        model_id: input.model_id,
        permission_mode: input.permission_mode,
        selected_project_id: input.selected_project_id,
        selected_session_id: input.selected_session_id,
    };

    write_settings(&conn, &settings)
}

pub fn set_project_expanded(input: SetProjectExpandedInput) -> Result<(), String> {
    validate_storage_id("project", &input.project_id)?;
    let conn = open_database()?;
    conn.execute(
        "UPDATE projects SET is_expanded = ?1, updated_at = ?2 WHERE id = ?3",
        params![
            bool_to_i64(input.is_expanded),
            now_unix_ms() as i64,
            input.project_id
        ],
    )
    .map_err(|error| db_error("Could not update the Wizzle project", error))?;

    Ok(())
}

pub fn rename_session(input: RenameSessionInput) -> Result<WorkspaceSnapshotPayload, String> {
    validate_storage_id("project", &input.project_id)?;
    validate_storage_id("session", &input.session_id)?;
    let normalized_title = input.title.trim();

    if normalized_title.is_empty() {
        return build_workspace_snapshot();
    }

    let conn = open_database()?;
    let timestamp = now_unix_ms();
    conn.execute(
        "
        UPDATE sessions
        SET title = ?1, updated_at = ?2
        WHERE id = ?3 AND project_id = ?4
        ",
        params![
            normalized_title,
            timestamp as i64,
            input.session_id,
            input.project_id
        ],
    )
    .map_err(|error| db_error("Could not rename the Wizzle session", error))?;
    conn.execute(
        "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
        params![timestamp as i64, input.project_id],
    )
    .map_err(|error| db_error("Could not update the Wizzle project", error))?;

    build_workspace_snapshot()
}

pub fn delete_session(input: DeleteSessionInput) -> Result<WorkspaceSnapshotPayload, String> {
    validate_storage_id("project", &input.project_id)?;
    validate_storage_id("session", &input.session_id)?;
    let mut conn = open_database()?;
    let session_exists = conn
        .query_row(
            "SELECT 1 FROM sessions WHERE id = ?1 AND project_id = ?2",
            params![input.session_id, input.project_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| db_error("Could not verify the Wizzle session", error))?
        .is_some();
    if !session_exists {
        return build_workspace_snapshot();
    }

    let quarantined = quarantine_session_directories(std::slice::from_ref(&input.session_id))?;
    let timestamp = now_unix_ms();
    let deletion_result = (|| {
        let tx = conn
            .transaction()
            .map_err(|error| db_error("Could not start session deletion", error))?;

        tx.execute(
            "DELETE FROM sessions WHERE id = ?1 AND project_id = ?2",
            params![input.session_id, input.project_id],
        )
        .map_err(|error| db_error("Could not delete the Wizzle session", error))?;
        tx.execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![timestamp as i64, input.project_id],
        )
        .map_err(|error| db_error("Could not update the Wizzle project", error))?;
        tx.execute(
            "
            UPDATE workspace_settings
            SET selected_session_id = NULL
            WHERE id = 1
              AND selected_project_id = ?1
              AND selected_session_id = ?2
            ",
            params![input.project_id, input.session_id],
        )
        .map_err(|error| db_error("Could not clear Wizzle selection", error))?;
        tx.commit()
            .map_err(|error| db_error("Could not finish session deletion", error))
    })();

    if let Err(error) = deletion_result {
        return Err(restore_after_failed_deletion(error, &quarantined));
    }

    finalize_quarantined_deletion(&quarantined);
    build_workspace_snapshot()
}

fn validate_attachment_size(size_bytes: u64, name: &str) -> Result<(), String> {
    if size_bytes > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "{name} is larger than 10 MB and cannot be attached."
        ));
    }

    Ok(())
}

fn build_attachment_record(
    attachments_dir: &Path,
    project_root: &Path,
    workspace_root: &Path,
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
            io_error(
                &format!("Could not inspect attachment {}", absolute_source.display()),
                error,
            )
        })?;
        let source_size = fs::metadata(&canonical_source)
            .map_err(|error| {
                io_error(
                    &format!(
                        "Could not inspect attachment {}",
                        canonical_source.display()
                    ),
                    error,
                )
            })?
            .len();
        validate_attachment_size(source_size, &preview.name)?;
        let bytes = fs::read(&canonical_source).map_err(|error| {
            io_error(
                &format!("Could not read attachment {}", canonical_source.display()),
                error,
            )
        })?;
        let file_hash = preview
            .content_hash
            .clone()
            .unwrap_or_else(|| content_hash(&bytes));
        let mime_type = preview
            .mime_type
            .clone()
            .or_else(|| mime_type_from_extension(&canonical_source))
            .or_else(|| Some("text/plain".to_string()));

        if canonical_source == project_root
            || canonical_source.starts_with(project_root)
            || canonical_source == workspace_root
            || canonical_source.starts_with(workspace_root)
        {
            let real_path = canonical_source.to_string_lossy().to_string();

            return Ok(StoredAttachmentRecord {
                content_hash: Some(file_hash),
                id: preview.id.clone(),
                kind: preview.kind.clone(),
                language: preview.language.clone(),
                mime_type,
                name: preview.name.clone(),
                original_path: preview.original_path.clone().or(Some(real_path.clone())),
                preview_metadata: preview.preview_metadata.clone(),
                real_path: Some(real_path),
                relative_path: String::new(),
                size_bytes: Some(source_size),
                summary: preview.summary.clone(),
            });
        }

        fs::write(&absolute_path, &bytes).map_err(|error| {
            io_error(
                &format!("Could not persist attachment {}", absolute_path.display()),
                error,
            )
        })?;

        return Ok(StoredAttachmentRecord {
            content_hash: Some(file_hash),
            id: preview.id.clone(),
            kind: preview.kind.clone(),
            language: preview.language.clone(),
            mime_type,
            name: preview.name.clone(),
            original_path: preview
                .original_path
                .clone()
                .or(Some(canonical_source.to_string_lossy().to_string())),
            preview_metadata: preview.preview_metadata.clone(),
            real_path: Some(canonical_source.to_string_lossy().to_string()),
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
        let (bytes, mime_type) = decode_data_url(image_src)?;
        (bytes, preview.mime_type.clone().or(mime_type))
    } else {
        (
            preview.content.clone().unwrap_or_default().into_bytes(),
            preview
                .mime_type
                .clone()
                .or_else(|| mime_type_from_extension(Path::new(&preview.name))),
        )
    };
    validate_attachment_size(bytes.len() as u64, &preview.name)?;
    let file_hash = preview
        .content_hash
        .clone()
        .unwrap_or_else(|| content_hash(&bytes));

    fs::write(&absolute_path, &bytes).map_err(|error| {
        io_error(
            &format!("Could not persist attachment {}", absolute_path.display()),
            error,
        )
    })?;

    Ok(StoredAttachmentRecord {
        content_hash: Some(file_hash),
        id: preview.id.clone(),
        kind: preview.kind.clone(),
        language: preview.language.clone(),
        mime_type,
        name: preview.name.clone(),
        original_path: preview.original_path.clone().or(Some(preview.path.clone())),
        preview_metadata: preview.preview_metadata.clone(),
        real_path: preview.real_path.clone(),
        relative_path: format!("attachments/{message_id}/{file_name}"),
        size_bytes: Some(bytes.len() as u64),
        summary: preview.summary.clone(),
    })
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
    let tool_arguments = input.tool_arguments;
    StoredMessageStepRecord {
        content: input.content,
        created_at_ms: input.created_at_ms,
        duration_ms: input.duration_ms,
        error: input.error,
        id: input.id,
        input: input.input.or(tool_arguments),
        metadata: input.metadata,
        name: input.name,
        output: input.output,
        parent_part_id: input.parent_part_id,
        pruned: input.pruned,
        status: input.status,
        tokens: input.tokens,
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
    workspace_root: &Path,
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

            build_attachment_record(
                attachments_dir,
                project_root,
                workspace_root,
                &message.id,
                preview,
            )
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
        reasoning: None,
        reasoning_duration_ms: None,
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

fn resolve_project_root_from_conn(conn: &Connection, project_id: &str) -> Result<PathBuf, String> {
    let project = read_project(conn, project_id)?
        .ok_or_else(|| format!("Could not find project {project_id}."))?;
    Ok(PathBuf::from(project.root_path))
}

fn message_turn_id(message: &StoredMessageRecord) -> String {
    message
        .turn_id
        .clone()
        .unwrap_or_else(|| format!("turn-{}", message.id))
}

fn message_turn_status(message: &StoredMessageRecord) -> String {
    match message.status.as_deref() {
        Some("streaming") => "running".to_string(),
        Some("error") => "error".to_string(),
        Some("interrupted") => "interrupted".to_string(),
        _ => "complete".to_string(),
    }
}

fn estimate_tokens(content: &str) -> i64 {
    ((content.chars().count() as f64) / 3.5).ceil() as i64
}

fn optional_text(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn insert_turn_if_needed(
    tx: &Transaction<'_>,
    session_id: &str,
    turn_indexes: &mut HashMap<String, (i64, i64)>,
    turn_id: &str,
    status: &str,
    created_at: u64,
    updated_at: u64,
) -> Result<i64, String> {
    if let Some((_, next_part_index)) = turn_indexes.get(turn_id) {
        tx.execute(
            "
            UPDATE turns
            SET status = ?2,
                updated_at = MAX(updated_at, ?3)
            WHERE id = ?1
            ",
            params![turn_id, status, updated_at as i64],
        )
        .map_err(|error| db_error("Could not update a Wizzle turn", error))?;
        return Ok(*next_part_index);
    }

    let turn_index = turn_indexes.len() as i64;
    tx.execute(
        "
        INSERT INTO turns (
          id, session_id, turn_index, status, compacted, total_tokens, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, ?6)
        ON CONFLICT(id) DO UPDATE SET
          session_id = excluded.session_id,
          turn_index = excluded.turn_index,
          status = excluded.status,
          created_at = MIN(turns.created_at, excluded.created_at),
          updated_at = MAX(turns.updated_at, excluded.updated_at)
        ",
        params![
            turn_id,
            session_id,
            turn_index,
            status,
            created_at as i64,
            updated_at as i64
        ],
    )
    .map_err(|error| db_error("Could not save a Wizzle turn", error))?;
    turn_indexes.insert(turn_id.to_string(), (turn_index, 0));

    Ok(0)
}

fn update_next_part_index(
    turn_indexes: &mut HashMap<String, (i64, i64)>,
    turn_id: &str,
) -> Result<i64, String> {
    let Some((_, next_part_index)) = turn_indexes.get_mut(turn_id) else {
        return Err("Could not resolve turn order while saving the chat.".to_string());
    };
    let part_index = *next_part_index;
    *next_part_index += 1;
    Ok(part_index)
}

/// Keep the first-assigned `part_index` for an existing part id.
/// Only allocate a new index when the part is first inserted.
fn resolve_stable_part_index(
    tx: &Transaction<'_>,
    turn_indexes: &mut HashMap<String, (i64, i64)>,
    turn_id: &str,
    part_id: &str,
) -> Result<i64, String> {
    let existing_index = tx
        .query_row(
            "SELECT part_index FROM turn_parts WHERE id = ?1",
            params![part_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| db_error("Could not read an existing Wizzle part index", error))?;

    if let Some(part_index) = existing_index {
        return Ok(part_index);
    }

    update_next_part_index(turn_indexes, turn_id)
}

fn load_turn_indexes(
    tx: &Transaction<'_>,
    session_id: &str,
) -> Result<HashMap<String, (i64, i64)>, String> {
    let mut statement = tx
        .prepare(
            "
            SELECT turns.id, turns.turn_index, COALESCE(MAX(turn_parts.part_index), -1) + 1
            FROM turns
            LEFT JOIN turn_parts ON turn_parts.turn_id = turns.id
            WHERE turns.session_id = ?1
            GROUP BY turns.id, turns.turn_index
            ORDER BY turns.turn_index ASC
            ",
        )
        .map_err(|error| db_error("Could not prepare Wizzle turn index loading", error))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, i64>(1)?, row.get::<_, i64>(2)?),
            ))
        })
        .map_err(|error| db_error("Could not read Wizzle turn indexes", error))?;

    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| db_error("Could not parse Wizzle turn indexes", error))
}

fn ensure_active_turn_can_update(tx: &Transaction<'_>, turn_id: &str) -> Result<(), String> {
    let status = tx
        .query_row(
            "SELECT status FROM turns WHERE id = ?1",
            params![turn_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| db_error("Could not read Wizzle turn status", error))?;

    if matches!(
        status.as_deref(),
        Some("complete") | Some("interrupted") | Some("error")
    ) {
        return Err("That turn is already finalized and cannot be updated.".to_string());
    }

    Ok(())
}

fn insert_file_records(
    tx: &Transaction<'_>,
    part_id: &str,
    attachments: &[StoredAttachmentRecord],
    created_at: u64,
) -> Result<(), String> {
    for attachment in attachments {
        let preview = serde_json::to_string(attachment)
            .map_err(|error| format!("Could not serialize attachment metadata: {error}"))?;
        let original_path = attachment.original_path.clone().unwrap_or_default();
        let stored_path = if attachment.relative_path.is_empty() {
            None
        } else {
            Some(attachment.relative_path.clone())
        };
        let mime_type = attachment
            .mime_type
            .clone()
            .or_else(|| mime_type_from_extension(Path::new(&attachment.name)))
            .unwrap_or_else(|| "text/plain".to_string());

        tx.execute(
            "
            INSERT INTO files (
              id, turn_part_id, original_path, stored_path, real_path, kind,
              mime_type, size, content_hash, preview, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(id) DO UPDATE SET
              turn_part_id = excluded.turn_part_id,
              original_path = excluded.original_path,
              stored_path = excluded.stored_path,
              real_path = excluded.real_path,
              kind = excluded.kind,
              mime_type = excluded.mime_type,
              size = excluded.size,
              content_hash = excluded.content_hash,
              preview = excluded.preview
            ",
            params![
                attachment.id,
                part_id,
                original_path,
                stored_path,
                attachment
                    .real_path
                    .clone()
                    .or_else(|| attachment.original_path.clone())
                    .unwrap_or_default(),
                attachment.kind,
                mime_type,
                attachment.size_bytes.unwrap_or(0) as i64,
                attachment.content_hash.clone().unwrap_or_default(),
                preview,
                created_at as i64
            ],
        )
        .map_err(|error| db_error("Could not save a Wizzle attachment record", error))?;
    }

    Ok(())
}

fn delete_stale_file_records(
    tx: &Transaction<'_>,
    part_id: &str,
    attachments: &[StoredAttachmentRecord],
) -> Result<(), String> {
    let attachment_ids = attachments
        .iter()
        .map(|attachment| attachment.id.clone())
        .collect::<HashSet<_>>();
    let mut statement = tx
        .prepare("SELECT id FROM files WHERE turn_part_id = ?1")
        .map_err(|error| db_error("Could not prepare Wizzle attachment cleanup", error))?;
    let rows = statement
        .query_map(params![part_id], |row| row.get::<_, String>(0))
        .map_err(|error| db_error("Could not read Wizzle attachments for cleanup", error))?;

    for row in rows {
        let file_id =
            row.map_err(|error| db_error("Could not parse Wizzle attachment cleanup row", error))?;
        if attachment_ids.contains(&file_id) {
            continue;
        }

        tx.execute("DELETE FROM files WHERE id = ?1", params![file_id])
            .map_err(|error| db_error("Could not clean up stale Wizzle attachments", error))?;
    }

    Ok(())
}

fn step_content(step: &StoredMessageStepRecord) -> String {
    step.output
        .clone()
        .or_else(|| step.content.clone())
        .or_else(|| step.input.clone())
        .unwrap_or_default()
}

fn step_metadata(message: &StoredMessageRecord, step: &StoredMessageStepRecord) -> Value {
    let mut metadata = step.metadata.clone().unwrap_or_else(|| json!({}));

    if let Some(object) = metadata.as_object_mut() {
        object
            .entry("messageId".to_string())
            .or_insert_with(|| json!(message.id));
        object
            .entry("role".to_string())
            .or_insert_with(|| json!(message.role));

        if let Some(name) = &step.name {
            object
                .entry("toolName".to_string())
                .or_insert_with(|| json!(name));
        }

        if let Some(input) = &step.input {
            object
                .entry("arguments".to_string())
                .or_insert_with(|| json!(input));
        }
    }

    metadata
}

fn part_id_exists(
    tx: &Transaction<'_>,
    inserted_part_ids: &HashSet<String>,
    part_id: &str,
) -> Result<bool, String> {
    if inserted_part_ids.contains(part_id) {
        return Ok(true);
    }

    let exists = tx
        .query_row(
            "SELECT 1 FROM turn_parts WHERE id = ?1",
            params![part_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| db_error("Could not check Wizzle parent part existence", error))?;

    Ok(exists.is_some())
}

/// Resolve a durable parent link for tool results.
/// Prefer the requested parent when it exists (this transaction or DB).
/// Resolve parent for a turn part.
/// - `tool_call` → assistant message anchor (`message_id`), never self
/// - `tool_result` → matching `tool_call` part (by tool_call_id)
/// - never returns the part's own id as parent
fn resolve_parent_part_id(
    tx: &Transaction<'_>,
    inserted_part_ids: &HashSet<String>,
    step_id: &str,
    step_type: &str,
    message_id: &str,
    requested_parent_part_id: Option<&str>,
    tool_call_id: Option<&str>,
) -> Result<Option<String>, String> {
    let requested = requested_parent_part_id.filter(|parent_id| *parent_id != step_id);

    if let Some(parent_id) = requested {
        if part_id_exists(tx, inserted_part_ids, parent_id)? {
            return Ok(Some(parent_id.to_string()));
        }
    }

    // tool_call parents the assistant message, not another tool_call (which became self on re-upsert).
    if step_type == "tool_call" {
        if !message_id.is_empty()
            && message_id != step_id
            && part_id_exists(tx, inserted_part_ids, message_id)?
        {
            return Ok(Some(message_id.to_string()));
        }
        return Ok(None);
    }

    // tool_result (and similar) fall back to the tool_call part matching tool_call_id.
    let Some(tool_call_id) = tool_call_id.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    let parent_from_tool_call = tx
        .query_row(
            "
            SELECT id
            FROM turn_parts
            WHERE tool_call_id = ?1
              AND part_type = 'tool_call'
            ORDER BY part_index ASC
            LIMIT 1
            ",
            params![tool_call_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| db_error("Could not resolve Wizzle tool-call parent part", error))?;

    Ok(parent_from_tool_call.filter(|parent_id| parent_id != step_id))
}

fn insert_normalized_message_steps(
    tx: &Transaction<'_>,
    inserted_part_ids: &mut HashSet<String>,
    message: &StoredMessageRecord,
    turn_id: &str,
    turn_indexes: &mut HashMap<String, (i64, i64)>,
) -> Result<(), String> {
    for step in &message.parts {
        if step.r#type == "reasoning" {
            continue;
        }

        if inserted_part_ids.contains(&step.id) {
            continue;
        }

        let part_index = resolve_stable_part_index(tx, turn_indexes, turn_id, &step.id)?;
        let content = step_content(step);
        let content_text = match step.r#type.as_str() {
            "activity_content" | "content" => step.content.clone(),
            _ => None,
        };
        let metadata = step_metadata(message, step);
        let metadata = serde_json::to_string(&metadata)
            .map_err(|error| format!("Could not serialize tool metadata: {error}"))?;
        let parent_part_id = resolve_parent_part_id(
            tx,
            inserted_part_ids,
            &step.id,
            &step.r#type,
            &message.id,
            step.parent_part_id.as_deref(),
            step.tool_call_id.as_deref(),
        )?;
        let updated_at = message.completed_at_ms.unwrap_or(message.created_at);
        let tokens = step
            .tokens
            .map(|value| value as i64)
            .unwrap_or_else(|| estimate_tokens(&content));
        let pruned = if step.pruned.unwrap_or(false) { 1 } else { 0 };

        tx.execute(
            "
            INSERT INTO turn_parts (
              id, turn_id, role, part_type, content, tokens, metadata, status,
              parent_part_id, tool_call_id, message_id, tool_name, tool_arguments,
              tool_output, tool_error, duration_ms, part_index, pruned, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
            ON CONFLICT(id) DO UPDATE SET
              turn_id = excluded.turn_id,
              role = excluded.role,
              part_type = excluded.part_type,
              content = excluded.content,
              tokens = excluded.tokens,
              metadata = excluded.metadata,
              status = excluded.status,
              parent_part_id = COALESCE(excluded.parent_part_id, turn_parts.parent_part_id),
              tool_call_id = excluded.tool_call_id,
              message_id = excluded.message_id,
              tool_name = excluded.tool_name,
              tool_arguments = excluded.tool_arguments,
              tool_output = excluded.tool_output,
              tool_error = excluded.tool_error,
              duration_ms = excluded.duration_ms,
              part_index = turn_parts.part_index,
              pruned = excluded.pruned,
              created_at = MIN(turn_parts.created_at, excluded.created_at),
              updated_at = excluded.updated_at
            ",
            params![
                step.id,
                turn_id,
                message.role,
                step.r#type,
                content_text,
                tokens,
                metadata,
                step.status.clone().unwrap_or_else(|| "done".to_string()),
                parent_part_id,
                step.tool_call_id,
                message.id,
                step.name,
                step.input,
                step.output,
                step.error,
                step.duration_ms.map(|value| value as i64),
                part_index,
                pruned,
                step.created_at_ms.unwrap_or(message.created_at) as i64,
                updated_at as i64
            ],
        )
        .map_err(|error| db_error("Could not save a Wizzle tool part", error))?;

        inserted_part_ids.insert(step.id.clone());
    }

    Ok(())
}

fn insert_message_part(
    tx: &Transaction<'_>,
    inserted_part_ids: &mut HashSet<String>,
    session_id: &str,
    turn_indexes: &mut HashMap<String, (i64, i64)>,
    message: &StoredMessageRecord,
    turn_status_override: Option<&str>,
) -> Result<(), String> {
    let turn_id = message_turn_id(message);
    let status = turn_status_override
        .map(str::to_string)
        .unwrap_or_else(|| message_turn_status(message));
    let updated_at = message.completed_at_ms.unwrap_or(message.created_at);
    insert_turn_if_needed(
        tx,
        session_id,
        turn_indexes,
        &turn_id,
        &status,
        message.created_at,
        updated_at,
    )?;
    let part_index = resolve_stable_part_index(tx, turn_indexes, &turn_id, &message.id)?;
    let content = if message.role == "user" {
        optional_text(&message.content)
    } else {
        None
    };

    tx.execute(
        "
        INSERT INTO turn_parts (
          id, turn_id, role, part_type, content, tokens, metadata, status,
          parent_part_id, tool_call_id, message_id, tool_name, assistant_phase,
          started_at, completed_at, duration_ms, edited_at, part_index, pruned,
          created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'message', ?4, ?5, '{}', ?6, NULL, ?7, ?1, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0, ?15, ?16)
        ON CONFLICT(id) DO UPDATE SET
          turn_id = excluded.turn_id,
          role = excluded.role,
          part_type = excluded.part_type,
          content = excluded.content,
          tokens = excluded.tokens,
          metadata = excluded.metadata,
          status = excluded.status,
          parent_part_id = excluded.parent_part_id,
          tool_call_id = excluded.tool_call_id,
          message_id = excluded.message_id,
          tool_name = excluded.tool_name,
          assistant_phase = excluded.assistant_phase,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          duration_ms = excluded.duration_ms,
          edited_at = excluded.edited_at,
          part_index = turn_parts.part_index,
          pruned = excluded.pruned,
          created_at = MIN(turn_parts.created_at, excluded.created_at),
          updated_at = excluded.updated_at
        ",
        params![
            message.id,
            turn_id,
            message.role,
            content,
            0,
            message.status.clone().unwrap_or_else(|| "done".to_string()),
            message.tool_call_id,
            message.tool_name,
            message.assistant_phase,
            message.started_at_ms.map(|value| value as i64),
            message.completed_at_ms.map(|value| value as i64),
            message.duration_ms.map(|value| value as i64),
            message.edited_at_ms.map(|value| value as i64),
            part_index,
            message.created_at as i64,
            updated_at as i64
        ],
    )
    .map_err(|error| db_error("Could not save a Wizzle message part", error))?;
    inserted_part_ids.insert(message.id.clone());

    insert_file_records(tx, &message.id, &message.attachments, message.created_at)?;
    delete_stale_file_records(tx, &message.id, &message.attachments)?;
    insert_normalized_message_steps(tx, inserted_part_ids, message, &turn_id, turn_indexes)
}

/// Persist replay budget estimates on the real conversation turn (#71).
/// Does not rewrite turn lifecycle status when the turn already exists.
fn upsert_turn_budget_summary(
    tx: &Transaction<'_>,
    session_id: &str,
    turn_indexes: &mut HashMap<String, (i64, i64)>,
    summary: &StoredTurnSummaryRecord,
) -> Result<(), String> {
    let message_ids = serde_json::to_string(&summary.message_ids)
        .map_err(|error| format!("Could not serialize Wizzle summary message ids: {error}"))?;

    let apply_budget = |tx: &Transaction<'_>| {
        tx.execute(
            "
            UPDATE turns
            SET estimated_tokens_image_capable = ?1,
                estimated_tokens_text_only = ?2,
                estimator_version = ?3,
                replay_message_count_image_capable = ?4,
                replay_message_count_text_only = ?5,
                summary_message_ids = ?6,
                summary_completed_at = ?7,
                total_tokens = CASE
                  WHEN total_tokens = 0 THEN ?2
                  ELSE total_tokens
                END,
                updated_at = MAX(updated_at, ?7)
            WHERE id = ?8
              AND session_id = ?9
            ",
            params![
                summary.estimated_tokens_image_capable as i64,
                summary.estimated_tokens_text_only as i64,
                summary.estimator_version as i64,
                summary.replay_message_count_image_capable as i64,
                summary.replay_message_count_text_only as i64,
                message_ids,
                summary.completed_at_ms as i64,
                summary.turn_id,
                session_id,
            ],
        )
        .map_err(|error| db_error("Could not save a Wizzle turn budget summary", error))
    };

    let mut updated = apply_budget(tx)?;
    if updated == 0 {
        // Turn row missing (edge case) — create shell, then apply budget.
        insert_turn_if_needed(
            tx,
            session_id,
            turn_indexes,
            &summary.turn_id,
            "complete",
            summary.completed_at_ms,
            summary.completed_at_ms,
        )?;
        updated = apply_budget(tx)?;
    }

    if updated == 0 {
        return Err(format!(
            "Could not save turn budget for missing turn {}.",
            summary.turn_id
        ));
    }

    // Drop legacy synthetic summary turns if they still exist.
    let legacy_turn_id = format!("summary-{}", summary.turn_id);
    let _ = tx.execute(
        "DELETE FROM turns WHERE session_id = ?1 AND (id = ?2 OR id = ?3)",
        params![
            session_id,
            legacy_turn_id,
            format!("summary-turn-{}", summary.turn_id)
        ],
    );

    Ok(())
}

fn delete_stale_transcript_rows(
    tx: &Transaction<'_>,
    session_id: &str,
    current_turn_ids: &HashSet<String>,
    current_part_ids: &HashSet<String>,
) -> Result<(), String> {
    // Refuse to wipe an entire session from an empty snapshot (#7).
    if current_turn_ids.is_empty() {
        let existing_turns = {
            let mut statement = tx
                .prepare("SELECT COUNT(*) FROM turns WHERE session_id = ?1")
                .map_err(|error| {
                    db_error("Could not count Wizzle turns for safety check", error)
                })?;
            statement
                .query_row(params![session_id], |row| row.get::<_, i64>(0))
                .map_err(|error| db_error("Could not count Wizzle turns for safety check", error))?
        };

        if existing_turns > 0 {
            return Err(
                "Refusing to delete session transcript from an empty snapshot.".to_string(),
            );
        }

        return Ok(());
    }

    let stale_part_ids = {
        let mut statement = tx
            .prepare(
                "
                SELECT turn_parts.id
                FROM turn_parts
                JOIN turns ON turns.id = turn_parts.turn_id
                WHERE turns.session_id = ?1
                ",
            )
            .map_err(|error| db_error("Could not prepare stale Wizzle turn part cleanup", error))?;
        let rows = statement
            .query_map(params![session_id], |row| row.get::<_, String>(0))
            .map_err(|error| db_error("Could not read stale Wizzle turn parts", error))?;
        rows.filter_map(|row| row.ok())
            .filter(|part_id| !current_part_ids.contains(part_id))
            .collect::<Vec<_>>()
    };

    for part_id in stale_part_ids {
        tx.execute("DELETE FROM turn_parts WHERE id = ?1", params![part_id])
            .map_err(|error| db_error("Could not delete stale Wizzle turn parts", error))?;
    }

    let stale_turn_ids = {
        let mut statement = tx
            .prepare("SELECT id FROM turns WHERE session_id = ?1")
            .map_err(|error| db_error("Could not prepare stale Wizzle turn cleanup", error))?;
        let rows = statement
            .query_map(params![session_id], |row| row.get::<_, String>(0))
            .map_err(|error| db_error("Could not read stale Wizzle turns", error))?;
        rows.filter_map(|row| row.ok())
            .filter(|turn_id| !current_turn_ids.contains(turn_id))
            .collect::<Vec<_>>()
    };

    for turn_id in stale_turn_ids {
        tx.execute("DELETE FROM turns WHERE id = ?1", params![turn_id])
            .map_err(|error| db_error("Could not delete stale Wizzle turns", error))?;
    }

    Ok(())
}

/// Immediately drop SQL turns not in `keep_turn_ids` so edit truncation is durable before the run (#3/#57).
pub fn truncate_session_transcript_to_turns(
    input: TruncateSessionTranscriptInput,
) -> Result<u32, String> {
    validate_storage_id("session", &input.session_id)?;

    let keep_turn_ids = input
        .keep_turn_ids
        .into_iter()
        .filter(|turn_id| !turn_id.trim().is_empty())
        .collect::<HashSet<_>>();

    // Editing the first message of a session can legitimately keep only the new turn.
    // An empty keep set with existing history is still refused (same as #7).
    let mut conn = open_database()?;
    let tx = conn
        .transaction()
        .map_err(|error| db_error("Could not start transcript truncate", error))?;

    let existing_turn_ids = {
        let mut statement = tx
            .prepare("SELECT id FROM turns WHERE session_id = ?1")
            .map_err(|error| db_error("Could not list Wizzle turns for truncate", error))?;
        let rows = statement
            .query_map(params![input.session_id], |row| row.get::<_, String>(0))
            .map_err(|error| db_error("Could not read Wizzle turns for truncate", error))?;
        rows.filter_map(|row| row.ok()).collect::<Vec<_>>()
    };

    if keep_turn_ids.is_empty() && !existing_turn_ids.is_empty() {
        return Err(
            "Refusing to delete the entire session transcript without retained turns.".to_string(),
        );
    }

    let mut deleted = 0u32;
    for turn_id in existing_turn_ids {
        if keep_turn_ids.contains(&turn_id) {
            continue;
        }

        // turn_parts cascade via FK ON DELETE CASCADE.
        tx.execute(
            "DELETE FROM turns WHERE id = ?1 AND session_id = ?2",
            params![turn_id, input.session_id],
        )
        .map_err(|error| db_error("Could not truncate Wizzle turn", error))?;
        deleted = deleted.saturating_add(1);
    }

    // Drop compacted flags / summary for turns that no longer exist is implicit (rows gone).
    // Compacted session summary may still mention deleted turns; next compact refresh is fine.

    tx.commit()
        .map_err(|error| db_error("Could not commit transcript truncate", error))?;

    Ok(deleted)
}

fn update_turn_token_totals(tx: &Transaction<'_>, session_id: &str) -> Result<(), String> {
    tx.execute(
        "
        UPDATE turns
        SET total_tokens = COALESCE((
          SELECT SUM(tokens)
          FROM turn_parts
          WHERE turn_parts.turn_id = turns.id
        ), 0)
        WHERE session_id = ?1
        ",
        params![session_id],
    )
    .map_err(|error| db_error("Could not update Wizzle turn token totals", error))?;

    Ok(())
}

fn build_session_metadata(
    project_id: String,
    input: PersistedSessionMetadataInput,
) -> StoredSessionMetadata {
    StoredSessionMetadata {
        compacted_context: input.compacted_context,
        created_at: input.created_at_ms,
        id: input.id,
        model_id: None,
        permission_mode: input.permission_mode,
        project_id,
        selected_model_uuid: input.selected_model_uuid.or(input.model_id),
        system_prompt_hash: input.system_prompt_hash,
        title: input.title,
        tokenizer_kind: input.tokenizer_kind,
        tool_def_tokens: input.tool_def_tokens,
        tool_defs_hash: input.tool_defs_hash,
        updated_at: input.updated_at_ms,
    }
}

fn upsert_session_metadata(
    tx: &Transaction<'_>,
    metadata: &StoredSessionMetadata,
) -> Result<(), String> {
    tx.execute(
        "
        INSERT INTO sessions (
          id, project_id, title, selected_provider_id, selected_model_uuid, selected_model_id,
          tokenizer_kind, system_prompt_hash, tool_def_tokens, tool_defs_hash, model_id,
          permission_mode, last_compacted_summary, last_compacted_tokens, last_compacted_at,
          max_context, created_at, updated_at
        ) VALUES (?1, ?2, ?3, (SELECT provider_id FROM models WHERE id = ?4), ?4, NULL, ?5, COALESCE(?6, ''), ?7, COALESCE(?8, ''), NULL, ?9, ?10, ?11, ?12, 128000, ?13, ?14)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          selected_provider_id = excluded.selected_provider_id,
          selected_model_uuid = excluded.selected_model_uuid,
          selected_model_id = excluded.selected_model_id,
          tokenizer_kind = excluded.tokenizer_kind,
          system_prompt_hash = excluded.system_prompt_hash,
          tool_def_tokens = excluded.tool_def_tokens,
          tool_defs_hash = excluded.tool_defs_hash,
          model_id = excluded.model_id,
          permission_mode = excluded.permission_mode,
          last_compacted_summary = excluded.last_compacted_summary,
          last_compacted_tokens = excluded.last_compacted_tokens,
          last_compacted_at = excluded.last_compacted_at,
          updated_at = excluded.updated_at
        ",
        params![
            metadata.id,
            metadata.project_id,
            metadata.title,
            metadata.selected_model_uuid,
            metadata.tokenizer_kind,
            metadata.system_prompt_hash,
            metadata.tool_def_tokens.map(|value| value as i64).unwrap_or(0),
            metadata.tool_defs_hash,
            metadata.permission_mode,
            metadata.compacted_context.as_ref().map(|context| context.summary.clone()),
            metadata
                .compacted_context
                .as_ref()
                .map(|context| context.tokens as i64)
                .unwrap_or(0),
            metadata
                .compacted_context
                .as_ref()
                .map(|context| context.updated_at_ms as i64),
            metadata.created_at as i64,
            metadata.updated_at as i64
        ],
    )
    .map_err(|error| db_error("Could not save the Wizzle session", error))?;

    Ok(())
}

/// Marks complete turns as compacted when session summary advances.
/// Used by both full `persist_session` and targeted metadata saves (compaction path).
fn mark_compacted_turns(
    tx: &Transaction<'_>,
    session_id: &str,
    compacted_turn_ids: &[String],
) -> Result<(), String> {
    for turn_id in compacted_turn_ids {
        tx.execute(
            "
            UPDATE turns
            SET compacted = 1
            WHERE session_id = ?1
              AND id = ?2
              AND status = 'complete'
            ",
            params![session_id, turn_id],
        )
        .map_err(|error| db_error("Could not mark compacted Wizzle turns", error))?;
    }

    Ok(())
}

pub fn create_session_if_needed(input: PersistSessionMetadataInput) -> Result<(), String> {
    validate_storage_id("project", &input.project_id)?;
    validate_storage_id("session", &input.session.id)?;
    let session_title = input.session.title.trim().to_string();

    if session_title.is_empty() {
        return Err("Could not save a session without a title.".to_string());
    }

    ensure_workspace_storage()?;
    let mut conn = open_database()?;
    resolve_project_root_from_conn(&conn, &input.project_id)?;
    let metadata = build_session_metadata(input.project_id.clone(), input.session);
    ensure_dir(&sqlite_session_dir(
        &ensure_workspace_storage()?,
        &metadata.id,
    )?)?;
    ensure_dir(&session_cache_dir(
        &ensure_workspace_storage()?,
        &metadata.id,
    )?)?;
    ensure_dir(&sqlite_session_attachments_dir(
        &ensure_workspace_storage()?,
        &metadata.id,
    )?)?;

    let tx = conn
        .transaction()
        .map_err(|error| db_error("Could not start targeted session persistence", error))?;
    upsert_session_metadata(&tx, &metadata)?;
    if let Some(compacted_context) = &metadata.compacted_context {
        mark_compacted_turns(&tx, &metadata.id, &compacted_context.compacted_turn_ids)?;
    }
    tx.execute(
        "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
        params![metadata.updated_at as i64, input.project_id],
    )
    .map_err(|error| db_error("Could not update the Wizzle project", error))?;
    tx.execute(
        "
        UPDATE workspace_settings
        SET selected_project_id = ?1,
            selected_session_id = ?2
        WHERE id = 1
        ",
        params![input.selected_project_id, input.selected_session_id],
    )
    .map_err(|error| db_error("Could not update Wizzle selection", error))?;
    tx.commit()
        .map_err(|error| db_error("Could not finish targeted session persistence", error))
}

pub fn update_session_title(input: UpdateSessionTitleInput) -> Result<(), String> {
    validate_storage_id("session", &input.session_id)?;
    let title = input.title.trim();

    if title.is_empty() {
        return Err("Could not save a session without a title.".to_string());
    }

    ensure_workspace_storage()?;
    let conn = open_database()?;
    conn.execute(
        "
        UPDATE sessions
        SET title = ?1,
            updated_at = MAX(updated_at, ?2)
        WHERE id = ?3
        ",
        params![title, input.updated_at_ms as i64, input.session_id],
    )
    .map_err(|error| db_error("Could not update the Wizzle session title", error))?;
    Ok(())
}

pub fn update_session_selection(input: UpdateSessionSelectionInput) -> Result<(), String> {
    validate_storage_id("project", &input.project_id)?;
    validate_storage_id("session", &input.session_id)?;
    ensure_workspace_storage()?;
    let conn = open_database()?;
    conn.execute(
        "
        UPDATE sessions
        SET selected_provider_id = (SELECT provider_id FROM models WHERE id = ?1),
            selected_model_uuid = ?1,
            selected_model_id = NULL,
            model_id = NULL,
            permission_mode = ?2,
            tokenizer_kind = ?3,
            tool_def_tokens = ?4,
            tool_defs_hash = COALESCE(?5, ''),
            updated_at = MAX(updated_at, ?6)
        WHERE id = ?7
          AND project_id = ?8
        ",
        params![
            input.selected_model_uuid,
            input.permission_mode,
            input.tokenizer_kind,
            input.tool_def_tokens.map(|value| value as i64).unwrap_or(0),
            input.tool_defs_hash,
            input.updated_at_ms as i64,
            input.session_id,
            input.project_id
        ],
    )
    .map_err(|error| db_error("Could not update the Wizzle session selection", error))?;
    Ok(())
}

pub fn append_or_update_message(input: AppendOrUpdateMessageInput) -> Result<(), String> {
    validate_storage_id("project", &input.project_id)?;
    validate_storage_id("session", &input.session_id)?;
    validate_storage_id("message", &input.message.id)?;

    let root = ensure_workspace_storage()?;
    let mut conn = open_database()?;
    let project_root = resolve_project_root_from_conn(&conn, &input.project_id)?;
    let session_dir_path = sqlite_session_dir(&root, &input.session_id)?;
    ensure_dir(&session_dir_path)?;
    ensure_dir(&session_cache_dir(&root, &input.session_id)?)?;
    let attachments_dir = sqlite_session_attachments_dir(&root, &input.session_id)?;
    ensure_dir(&attachments_dir)?;
    let preview_file_map = input
        .preview_files
        .into_iter()
        .map(|preview| (preview.id.clone(), preview))
        .collect::<BTreeMap<_, _>>();
    let message = build_stored_message(
        &attachments_dir,
        &project_root,
        &root,
        &preview_file_map,
        input.message,
    )?;
    let turn_id = message_turn_id(&message);

    let tx = conn
        .transaction()
        .map_err(|error| db_error("Could not start targeted message persistence", error))?;
    ensure_active_turn_can_update(&tx, &turn_id)?;
    let mut turn_indexes = load_turn_indexes(&tx, &input.session_id)?;
    let mut inserted_part_ids = HashSet::new();
    insert_message_part(
        &tx,
        &mut inserted_part_ids,
        &input.session_id,
        &mut turn_indexes,
        &message,
        Some("running"),
    )?;
    update_turn_token_totals(&tx, &input.session_id)?;
    tx.execute(
        "
        UPDATE sessions
        SET updated_at = MAX(updated_at, ?1)
        WHERE id = ?2
        ",
        params![message.created_at as i64, input.session_id],
    )
    .map_err(|error| db_error("Could not update the Wizzle session timestamp", error))?;
    tx.commit()
        .map_err(|error| db_error("Could not finish targeted message persistence", error))
}

pub fn upsert_turn_summary(input: UpsertTurnSummaryInput) -> Result<(), String> {
    validate_storage_id("session", &input.session_id)?;
    validate_storage_id("turn", &input.summary.turn_id)?;
    ensure_workspace_storage()?;
    let mut conn = open_database()?;
    let summary = build_stored_turn_summary(input.summary);
    let tx = conn
        .transaction()
        .map_err(|error| db_error("Could not start turn summary persistence", error))?;
    let mut turn_indexes = load_turn_indexes(&tx, &input.session_id)?;
    upsert_turn_budget_summary(&tx, &input.session_id, &mut turn_indexes, &summary)?;
    tx.commit()
        .map_err(|error| db_error("Could not finish turn summary persistence", error))
}

fn resolve_finalize_turn_result(
    turn_id: &str,
    desired_status: &str,
    rows_updated: usize,
    current_status: Option<&str>,
) -> Result<(), String> {
    if rows_updated > 0 {
        return Ok(());
    }

    match current_status {
        None => Err(format!(
            "Could not finalize turn {turn_id} because it was not found."
        )),
        // Idempotent: already closed with the same terminal status.
        Some(existing) if existing == desired_status => Ok(()),
        // Already terminal under a different label — still closed, not stuck running.
        Some("complete") | Some("interrupted") | Some("error") => Ok(()),
        Some(existing) => Err(format!(
            "Could not finalize turn {turn_id} from status {existing}."
        )),
    }
}

pub fn finalize_turn(input: FinalizeTurnInput) -> Result<(), String> {
    validate_storage_id("session", &input.session_id)?;
    validate_storage_id("turn", &input.turn_id)?;
    let status = match input.status.as_str() {
        "done" => "complete",
        "interrupted" => "interrupted",
        "failed" => "error",
        _ => return Err("Could not finalize a turn with an unknown status.".to_string()),
    };

    ensure_workspace_storage()?;
    let conn = open_database()?;
    let updated = conn
        .execute(
            "
            UPDATE turns
            SET status = ?1,
                updated_at = MAX(updated_at, ?2)
            WHERE id = ?3
              AND session_id = ?4
              AND status = 'running'
            ",
            params![
                status,
                input.updated_at_ms as i64,
                input.turn_id,
                input.session_id
            ],
        )
        .map_err(|error| db_error("Could not finalize the Wizzle turn", error))?;

    if updated > 0 {
        return Ok(());
    }

    let current_status = conn
        .query_row(
            "SELECT status FROM turns WHERE id = ?1 AND session_id = ?2",
            params![input.turn_id, input.session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| db_error("Could not read Wizzle turn status after finalize", error))?;

    resolve_finalize_turn_result(&input.turn_id, status, updated, current_status.as_deref())
}

pub fn persist_session(input: PersistWorkspaceSessionInput) -> Result<(), String> {
    validate_storage_id("project", &input.project_id)?;
    validate_storage_id("session", &input.session.id)?;
    let session_title = input.session.title.trim().to_string();

    if session_title.is_empty() {
        return Err("Could not save a session without a title.".to_string());
    }

    let root = ensure_workspace_storage()?;
    let mut conn = open_database()?;
    let project_root = resolve_project_root_from_conn(&conn, &input.project_id)?;
    let session_dir_path = sqlite_session_dir(&root, &input.session.id)?;
    ensure_dir(&session_dir_path)?;
    ensure_dir(&session_cache_dir(&root, &input.session.id)?)?;
    let attachments_dir = sqlite_session_attachments_dir(&root, &input.session.id)?;
    let staged_attachments_dir = session_dir_path.join("attachments.staging");
    let backup_attachments_dir = session_dir_path.join("attachments.backup");

    if staged_attachments_dir.exists() {
        fs::remove_dir_all(&staged_attachments_dir)
            .map_err(|error| io_error("Could not prepare attachment staging", error))?;
    }
    if backup_attachments_dir.exists() {
        fs::remove_dir_all(&backup_attachments_dir)
            .map_err(|error| io_error("Could not clear attachment backup", error))?;
    }
    ensure_dir(&staged_attachments_dir)?;

    let session_input = input.session;
    let session_id = session_input.id.clone();
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
                &root,
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
        compacted_context: session_input.compacted_context,
        project_id: input.project_id.clone(),
        selected_model_uuid: session_input.selected_model_uuid,
        system_prompt_hash: session_input.system_prompt_hash,
        tokenizer_kind: session_input.tokenizer_kind,
        tool_def_tokens: session_input.tool_def_tokens,
        tool_defs_hash: session_input.tool_defs_hash,
        title: session_title,
        updated_at: session_input.updated_at_ms.max(now),
    };

    if attachments_dir.exists() {
        fs::rename(&attachments_dir, &backup_attachments_dir)
            .map_err(|error| io_error("Could not rotate existing attachments", error))?;
    }

    if let Err(error) = fs::rename(&staged_attachments_dir, &attachments_dir) {
        if backup_attachments_dir.exists() {
            let _ = fs::rename(&backup_attachments_dir, &attachments_dir);
        }

        return Err(io_error("Could not finalize attachments", error));
    }

    let persist_result = (|| -> Result<(), String> {
        let tx = conn
            .transaction()
            .map_err(|error| db_error("Could not start session persistence", error))?;

        tx.execute(
            "
            INSERT INTO sessions (
              id, project_id, title, selected_provider_id, selected_model_uuid, selected_model_id,
              tokenizer_kind, system_prompt_hash, tool_def_tokens, tool_defs_hash, model_id,
              permission_mode, last_compacted_summary, last_compacted_tokens, last_compacted_at,
              max_context, created_at, updated_at
            ) VALUES (?1, ?2, ?3, (SELECT provider_id FROM models WHERE id = ?4), ?4, NULL, ?5, COALESCE(?6, ''), ?7, COALESCE(?8, ''), NULL, ?9, ?10, ?11, ?12, 128000, ?13, ?14)
            ON CONFLICT(id) DO UPDATE SET
              project_id = excluded.project_id,
              title = excluded.title,
              selected_provider_id = excluded.selected_provider_id,
              selected_model_uuid = excluded.selected_model_uuid,
              selected_model_id = excluded.selected_model_id,
              tokenizer_kind = excluded.tokenizer_kind,
              system_prompt_hash = excluded.system_prompt_hash,
              tool_def_tokens = excluded.tool_def_tokens,
              tool_defs_hash = excluded.tool_defs_hash,
              model_id = excluded.model_id,
              permission_mode = excluded.permission_mode,
              last_compacted_summary = excluded.last_compacted_summary,
              last_compacted_tokens = excluded.last_compacted_tokens,
              last_compacted_at = excluded.last_compacted_at,
              updated_at = excluded.updated_at
            ",
            params![
                metadata.id,
                metadata.project_id,
                metadata.title,
                metadata.selected_model_uuid,
                metadata.tokenizer_kind,
                metadata.system_prompt_hash,
                metadata.tool_def_tokens.map(|value| value as i64).unwrap_or(0),
                metadata.tool_defs_hash,
                metadata.permission_mode,
                metadata.compacted_context.as_ref().map(|context| context.summary.clone()),
                metadata
                    .compacted_context
                    .as_ref()
                    .map(|context| context.tokens as i64)
                    .unwrap_or(0),
                metadata
                    .compacted_context
                    .as_ref()
                    .map(|context| context.updated_at_ms as i64),
                metadata.created_at as i64,
                metadata.updated_at as i64
            ],
        )
        .map_err(|error| db_error("Could not save the Wizzle session", error))?;
        // Real conversation turns only — budget metadata is columns on those rows (#71).
        let expected_turn_ids = messages.iter().map(message_turn_id).collect::<HashSet<_>>();
        let expected_part_ids = messages
            .iter()
            .flat_map(|message| {
                std::iter::once(message.id.clone()).chain(
                    message
                        .parts
                        .iter()
                        .filter(|part| part.r#type != "reasoning")
                        .map(|part| part.id.clone()),
                )
            })
            .collect::<HashSet<_>>();
        delete_stale_transcript_rows(&tx, &session_id, &expected_turn_ids, &expected_part_ids)?;
        let mut turn_indexes = HashMap::new();
        let mut inserted_part_ids = HashSet::new();
        for message in &messages {
            insert_message_part(
                &tx,
                &mut inserted_part_ids,
                &session_id,
                &mut turn_indexes,
                message,
                None,
            )?;
        }
        for summary in &turn_summaries {
            upsert_turn_budget_summary(&tx, &session_id, &mut turn_indexes, summary)?;
        }
        let current_turn_ids = turn_indexes.keys().cloned().collect::<HashSet<_>>();
        delete_stale_transcript_rows(&tx, &session_id, &current_turn_ids, &inserted_part_ids)?;
        if let Some(compacted_context) = &metadata.compacted_context {
            mark_compacted_turns(&tx, &session_id, &compacted_context.compacted_turn_ids)?;
        }
        update_turn_token_totals(&tx, &session_id)?;

        tx.execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![metadata.updated_at as i64, input.project_id],
        )
        .map_err(|error| db_error("Could not update the Wizzle project", error))?;
        tx.execute(
            "
            UPDATE workspace_settings
            SET selected_project_id = ?1,
                selected_session_id = ?2
            WHERE id = 1
            ",
            params![input.selected_project_id, input.selected_session_id],
        )
        .map_err(|error| db_error("Could not update Wizzle selection", error))?;

        tx.commit()
            .map_err(|error| db_error("Could not finish session persistence", error))?;
        Ok(())
    })();

    if let Err(error) = persist_result {
        let _ = fs::remove_dir_all(&attachments_dir);

        if backup_attachments_dir.exists() {
            let _ = fs::rename(&backup_attachments_dir, &attachments_dir);
        }

        return Err(error);
    }

    if backup_attachments_dir.exists() {
        fs::remove_dir_all(&backup_attachments_dir)
            .map_err(|error| io_error("Could not clean up attachment backup", error))?;
    }

    log_desktop_event(
        "info",
        "desktop.workspace",
        "sqlite_session_persisted",
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
    validate_storage_id("project", project_id)?;
    let conn = open_database()?;
    resolve_project_root_from_conn(&conn, project_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("wizzle-{label}-{}", Uuid::new_v4()))
    }

    fn migrated_memory_db() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .expect("enable foreign keys");
        run_migrations(&mut conn).expect("run migrations");
        conn
    }

    fn table_exists(conn: &Connection, table_name: &str) -> bool {
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table_name],
            |_| Ok(()),
        )
        .optional()
        .expect("query sqlite master")
        .is_some()
    }

    fn row_count(conn: &Connection, table_name: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table_name}"), [], |row| {
            row.get(0)
        })
        .expect("read row count")
    }

    fn insert_test_session(conn: &Connection) {
        let now = now_unix_ms() as i64;

        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('project-1', 'Project', '/tmp/project', ?1, ?1)",
            params![now],
        )
        .expect("insert project");
        conn.execute(
            "INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES ('session-1', 'project-1', 'Session', ?1, ?1)",
            params![now],
        )
        .expect("insert session");
    }

    #[test]
    fn migration_creates_phase_one_tables_and_default_settings() {
        let conn = migrated_memory_db();

        for table_name in [
            "schema_migrations",
            "providers",
            "models",
            "provider_imports",
            "projects",
            "sessions",
            "composer_drafts",
            "queued_messages",
            "turns",
            "turn_parts",
            "files",
            "processes",
            "workspace_settings",
        ] {
            assert!(table_exists(&conn, table_name), "{table_name} should exist");
        }

        let settings = read_settings(&conn).expect("read settings");
        assert!(settings.is_file_panel_open);
        assert!(settings.is_sidebar_open);
        assert_eq!(settings.model_id, "wizzle-1-thinking");
        assert_eq!(settings.permission_mode, "manual-approve");
    }

    #[test]
    fn completed_migrations_are_cached_for_the_database_path() {
        let db_path = unique_temp_path("migration-cache").with_extension("db");
        let mut conn = Connection::open(&db_path).expect("open database");
        ensure_database_migrated(&mut conn, &db_path).expect("migrate database");
        conn.execute("DROP TABLE schema_migrations", [])
            .expect("remove migration marker");
        drop(conn);

        let mut reopened = Connection::open(&db_path).expect("reopen database");
        ensure_database_migrated(&mut reopened, &db_path).expect("use cached migration");
        assert!(!table_exists(&reopened, "schema_migrations"));
        drop(reopened);
        fs::remove_file(db_path).expect("remove test database");
    }

    #[test]
    fn project_ids_are_uuid_backed_and_unique() {
        let mut project_ids = (0..32)
            .map(|_| std::thread::spawn(new_project_id))
            .map(|handle| handle.join().expect("generate project ID"))
            .collect::<Vec<_>>();
        project_ids.sort();
        project_ids.dedup();

        assert_eq!(project_ids.len(), 32);
        for project_id in project_ids {
            assert!(project_id.starts_with("project-"));
            Uuid::parse_str(project_id.trim_start_matches("project-")).expect("parse project UUID");
        }
    }

    #[test]
    fn failed_deletion_restores_quarantined_session_directory() {
        let root = unique_temp_path("deletion-restore");
        let original = root.join("session-1");
        let quarantined = root.join("trash-session-1");
        fs::create_dir_all(&original).expect("create original directory");
        fs::write(original.join("attachment.txt"), "private").expect("write attachment");
        fs::rename(&original, &quarantined).expect("quarantine directory");
        let entries = vec![QuarantinedSessionDirectory {
            original: original.clone(),
            quarantined,
            session_id: "session-1".to_string(),
        }];

        let error = restore_after_failed_deletion("database failed".to_string(), &entries);

        assert_eq!(error, "database failed");
        assert_eq!(
            fs::read_to_string(original.join("attachment.txt")).expect("read restored attachment"),
            "private"
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn deleting_session_cascades_dependent_rows() {
        let conn = migrated_memory_db();
        let now = now_unix_ms() as i64;

        insert_test_session(&conn);
        conn.execute(
            "INSERT INTO composer_drafts (session_id, draft_text, updated_at) VALUES ('session-1', 'draft', ?1)",
            params![now],
        )
        .expect("insert draft");
        conn.execute(
            "INSERT INTO queued_messages (id, session_id, content, attachments_json, queue_index, status, created_at, updated_at) VALUES ('queue-1', 'session-1', 'queued', '[]', 0, 'queued', ?1, ?1)",
            params![now],
        )
        .expect("insert queue");
        conn.execute(
            "INSERT INTO processes (id, session_id, command, cwd, status, started_at) VALUES ('process-1', 'session-1', 'npm run dev', '/tmp/project', 'running', ?1)",
            params![now],
        )
        .expect("insert process");
        conn.execute(
            "INSERT INTO turns (id, session_id, turn_index, status, created_at, updated_at) VALUES ('turn-1', 'session-1', 0, 'complete', ?1, ?1)",
            params![now],
        )
        .expect("insert turn");
        conn.execute(
            "INSERT INTO turn_parts (id, turn_id, role, part_type, content, part_index, created_at, updated_at) VALUES ('part-1', 'turn-1', 'user', 'message', '{}', 0, ?1, ?1)",
            params![now],
        )
        .expect("insert turn part");
        conn.execute(
            "INSERT INTO files (id, turn_part_id, original_path, real_path, kind, mime_type, created_at) VALUES ('file-1', 'part-1', '/tmp/project/a.ts', '/tmp/project/a.ts', 'text', 'text/plain', ?1)",
            params![now],
        )
        .expect("insert file");

        conn.execute("DELETE FROM sessions WHERE id = 'session-1'", [])
            .expect("delete session");

        for table_name in [
            "sessions",
            "composer_drafts",
            "queued_messages",
            "processes",
            "turns",
            "turn_parts",
            "files",
        ] {
            assert_eq!(
                row_count(&conn, table_name),
                0,
                "{table_name} should cascade"
            );
        }
        assert_eq!(row_count(&conn, "projects"), 1);
    }

    #[test]
    fn assistant_text_is_saved_once_and_turn_status_recovers_from_streaming() {
        let mut conn = migrated_memory_db();
        let now = now_unix_ms();
        insert_test_session(&conn);

        let mut assistant = StoredMessageRecord {
            content: "Hello. How can I help you today?".to_string(),
            created_at: now,
            id: "message-assistant-1".to_string(),
            role: "assistant".to_string(),
            started_at_ms: Some(now),
            status: Some("streaming".to_string()),
            turn_id: Some("turn-1".to_string()),
            parts: vec![StoredMessageStepRecord {
                content: Some("Hello. How can I help you today?".to_string()),
                created_at_ms: Some(now),
                id: "message-assistant-1-content".to_string(),
                status: Some("streaming".to_string()),
                r#type: "content".to_string(),
                ..StoredMessageStepRecord::default()
            }],
            ..StoredMessageRecord::default()
        };

        {
            let tx = conn.transaction().expect("start streaming tx");
            let mut turn_indexes = HashMap::new();
            let mut inserted_part_ids = HashSet::new();
            insert_message_part(
                &tx,
                &mut inserted_part_ids,
                "session-1",
                &mut turn_indexes,
                &assistant,
                None,
            )
            .expect("insert streaming assistant");
            tx.commit().expect("commit streaming");
        }

        assistant.completed_at_ms = Some(now + 10);
        assistant.status = Some("done".to_string());
        assistant.parts[0].status = Some("done".to_string());
        {
            let tx = conn.transaction().expect("start completed tx");
            let mut turn_indexes = HashMap::new();
            let mut inserted_part_ids = HashSet::new();
            insert_message_part(
                &tx,
                &mut inserted_part_ids,
                "session-1",
                &mut turn_indexes,
                &assistant,
                None,
            )
            .expect("update completed assistant");
            tx.commit().expect("commit completed");
        }

        let anchor_content: Option<String> = conn
            .query_row(
                "SELECT content FROM turn_parts WHERE id = 'message-assistant-1'",
                [],
                |row| row.get(0),
            )
            .expect("read assistant anchor content");
        let part_content: String = conn
            .query_row(
                "SELECT content FROM turn_parts WHERE id = 'message-assistant-1-content'",
                [],
                |row| row.get(0),
            )
            .expect("read assistant content part");
        let turn_status: String = conn
            .query_row("SELECT status FROM turns WHERE id = 'turn-1'", [], |row| {
                row.get(0)
            })
            .expect("read turn status");

        assert_eq!(anchor_content, None);
        assert_eq!(part_content, "Hello. How can I help you today?");
        assert_eq!(turn_status, "complete");
    }

    #[test]
    fn targeted_active_message_write_preserves_completed_turn_rows() {
        let mut conn = migrated_memory_db();
        let now = now_unix_ms();
        insert_test_session(&conn);
        conn.execute(
            "INSERT INTO turns (id, session_id, turn_index, status, created_at, updated_at) VALUES ('turn-old', 'session-1', 0, 'complete', ?1, ?1)",
            params![now as i64],
        )
        .expect("insert old turn");
        conn.execute(
            "INSERT INTO turn_parts (id, turn_id, role, part_type, content, part_index, created_at, updated_at) VALUES ('message-old', 'turn-old', 'user', 'message', 'old', 0, ?1, ?1)",
            params![now as i64],
        )
        .expect("insert old message");

        let message = StoredMessageRecord {
            content: "new".to_string(),
            created_at: now + 1,
            id: "message-new".to_string(),
            role: "user".to_string(),
            status: Some("done".to_string()),
            turn_id: Some("turn-new".to_string()),
            ..StoredMessageRecord::default()
        };
        let tx = conn.transaction().expect("start targeted write");
        ensure_active_turn_can_update(&tx, "turn-new").expect("new turn is mutable");
        let mut turn_indexes = load_turn_indexes(&tx, "session-1").expect("load turn indexes");
        let mut inserted_part_ids = HashSet::new();
        insert_message_part(
            &tx,
            &mut inserted_part_ids,
            "session-1",
            &mut turn_indexes,
            &message,
            Some("running"),
        )
        .expect("insert targeted message");
        tx.commit().expect("commit targeted write");

        let old_part_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM turn_parts WHERE id = 'message-old'",
                [],
                |row| row.get(0),
            )
            .expect("count old part");
        let new_turn_status: String = conn
            .query_row(
                "SELECT status FROM turns WHERE id = 'turn-new'",
                [],
                |row| row.get(0),
            )
            .expect("read new turn status");

        assert_eq!(old_part_count, 1);
        assert_eq!(new_turn_status, "running");
    }

    #[test]
    fn reupserting_messages_preserves_part_index_order() {
        let mut conn = migrated_memory_db();
        let now = now_unix_ms();
        insert_test_session(&conn);

        let user = StoredMessageRecord {
            content: "hello".to_string(),
            created_at: now,
            id: "message-user-1".to_string(),
            role: "user".to_string(),
            status: Some("done".to_string()),
            turn_id: Some("turn-1".to_string()),
            ..StoredMessageRecord::default()
        };
        let assistant = StoredMessageRecord {
            content: String::new(),
            created_at: now + 1,
            id: "message-assistant-1".to_string(),
            role: "assistant".to_string(),
            status: Some("streaming".to_string()),
            turn_id: Some("turn-1".to_string()),
            parts: vec![StoredMessageStepRecord {
                content: Some("thinking".to_string()),
                created_at_ms: Some(now + 1),
                id: "message-assistant-1-content".to_string(),
                status: Some("streaming".to_string()),
                r#type: "content".to_string(),
                ..StoredMessageStepRecord::default()
            }],
            ..StoredMessageRecord::default()
        };

        {
            let tx = conn.transaction().expect("start first write");
            let mut turn_indexes = load_turn_indexes(&tx, "session-1").expect("load indexes");
            let mut inserted_part_ids = HashSet::new();
            insert_message_part(
                &tx,
                &mut inserted_part_ids,
                "session-1",
                &mut turn_indexes,
                &user,
                Some("running"),
            )
            .expect("insert user");
            insert_message_part(
                &tx,
                &mut inserted_part_ids,
                "session-1",
                &mut turn_indexes,
                &assistant,
                Some("running"),
            )
            .expect("insert assistant");
            tx.commit().expect("commit first write");
        }

        let user_index_before: i64 = conn
            .query_row(
                "SELECT part_index FROM turn_parts WHERE id = 'message-user-1'",
                [],
                |row| row.get(0),
            )
            .expect("read user index");
        let assistant_index_before: i64 = conn
            .query_row(
                "SELECT part_index FROM turn_parts WHERE id = 'message-assistant-1'",
                [],
                |row| row.get(0),
            )
            .expect("read assistant index");
        assert!(
            user_index_before < assistant_index_before,
            "user should sort before assistant initially"
        );

        // Re-persist user last (settle path). Index must stay stable.
        let updated_user = StoredMessageRecord {
            content: "hello".to_string(),
            completed_at_ms: Some(now + 10),
            created_at: now,
            id: "message-user-1".to_string(),
            role: "user".to_string(),
            status: Some("done".to_string()),
            turn_id: Some("turn-1".to_string()),
            ..StoredMessageRecord::default()
        };
        {
            let tx = conn.transaction().expect("start reupsert");
            let mut turn_indexes = load_turn_indexes(&tx, "session-1").expect("load indexes");
            let mut inserted_part_ids = HashSet::new();
            insert_message_part(
                &tx,
                &mut inserted_part_ids,
                "session-1",
                &mut turn_indexes,
                &updated_user,
                Some("running"),
            )
            .expect("reupsert user");
            tx.commit().expect("commit reupsert");
        }

        let user_index_after: i64 = conn
            .query_row(
                "SELECT part_index FROM turn_parts WHERE id = 'message-user-1'",
                [],
                |row| row.get(0),
            )
            .expect("read user index after");
        let assistant_index_after: i64 = conn
            .query_row(
                "SELECT part_index FROM turn_parts WHERE id = 'message-assistant-1'",
                [],
                |row| row.get(0),
            )
            .expect("read assistant index after");

        assert_eq!(user_index_after, user_index_before);
        assert_eq!(assistant_index_after, assistant_index_before);
        assert!(
            user_index_after < assistant_index_after,
            "reupsert must not move user after assistant"
        );

        // Re-persist assistant content streaming update; content part index must stay stable.
        let content_index_before: i64 = conn
            .query_row(
                "SELECT part_index FROM turn_parts WHERE id = 'message-assistant-1-content'",
                [],
                |row| row.get(0),
            )
            .expect("read content index");
        let updated_assistant = StoredMessageRecord {
            content: String::new(),
            created_at: now + 1,
            id: "message-assistant-1".to_string(),
            role: "assistant".to_string(),
            status: Some("streaming".to_string()),
            turn_id: Some("turn-1".to_string()),
            parts: vec![StoredMessageStepRecord {
                content: Some("thinking more".to_string()),
                created_at_ms: Some(now + 1),
                id: "message-assistant-1-content".to_string(),
                status: Some("streaming".to_string()),
                r#type: "content".to_string(),
                ..StoredMessageStepRecord::default()
            }],
            ..StoredMessageRecord::default()
        };
        {
            let tx = conn.transaction().expect("start assistant reupsert");
            let mut turn_indexes = load_turn_indexes(&tx, "session-1").expect("load indexes");
            let mut inserted_part_ids = HashSet::new();
            insert_message_part(
                &tx,
                &mut inserted_part_ids,
                "session-1",
                &mut turn_indexes,
                &updated_assistant,
                Some("running"),
            )
            .expect("reupsert assistant");
            tx.commit().expect("commit assistant reupsert");
        }
        let content_index_after: i64 = conn
            .query_row(
                "SELECT part_index FROM turn_parts WHERE id = 'message-assistant-1-content'",
                [],
                |row| row.get(0),
            )
            .expect("read content index after");
        let content_text: String = conn
            .query_row(
                "SELECT content FROM turn_parts WHERE id = 'message-assistant-1-content'",
                [],
                |row| row.get(0),
            )
            .expect("read content text");

        assert_eq!(content_index_after, content_index_before);
        assert_eq!(content_text, "thinking more");
    }

    #[test]
    fn tool_messages_with_provider_ids_persist_results_and_parent_links() {
        let mut conn = migrated_memory_db();
        let now = now_unix_ms();
        insert_test_session(&conn);

        let tool_call_id = "call_00_ABzCHrM8TDY9yQ6gWYME8154";
        let assistant_id = "message-assistant-2fc8bdd8-067a-4cb0-863b-dce69787e1d4";
        let tool_call_part_id = format!("{assistant_id}-tool-call-{tool_call_id}");
        let tool_message_id = format!("message-tool-{tool_call_id}");
        let tool_result_part_id = format!("{tool_message_id}-result");

        let assistant = StoredMessageRecord {
            created_at: now,
            id: assistant_id.to_string(),
            role: "assistant".to_string(),
            status: Some("done".to_string()),
            turn_id: Some("turn-1".to_string()),
            parts: vec![StoredMessageStepRecord {
                created_at_ms: Some(now),
                id: tool_call_part_id.clone(),
                input: Some(r#"{"command":"ls"}"#.to_string()),
                name: Some("bash".to_string()),
                status: Some("done".to_string()),
                tool_call_id: Some(tool_call_id.to_string()),
                r#type: "tool_call".to_string(),
                ..StoredMessageStepRecord::default()
            }],
            ..StoredMessageRecord::default()
        };

        {
            let tx = conn.transaction().expect("start assistant write");
            let mut turn_indexes = load_turn_indexes(&tx, "session-1").expect("indexes");
            let mut inserted = HashSet::new();
            insert_message_part(
                &tx,
                &mut inserted,
                "session-1",
                &mut turn_indexes,
                &assistant,
                Some("running"),
            )
            .expect("insert assistant with tool_call");
            tx.commit().expect("commit assistant");
        }

        let tool_call_parent: Option<String> = conn
            .query_row(
                "SELECT parent_part_id FROM turn_parts WHERE id = ?1",
                params![tool_call_part_id],
                |row| row.get(0),
            )
            .expect("read tool_call parent");
        assert_eq!(
            tool_call_parent.as_deref(),
            Some(assistant_id),
            "tool_call must parent the assistant message, not itself"
        );
        assert_ne!(
            tool_call_parent.as_deref(),
            Some(tool_call_part_id.as_str()),
            "tool_call must not self-parent"
        );

        // Re-upsert the same assistant tool_call — must not flip parent to self.
        {
            let tx = conn.transaction().expect("start assistant reupsert");
            let mut turn_indexes = load_turn_indexes(&tx, "session-1").expect("indexes");
            let mut inserted = HashSet::new();
            insert_message_part(
                &tx,
                &mut inserted,
                "session-1",
                &mut turn_indexes,
                &assistant,
                Some("running"),
            )
            .expect("reupsert assistant with tool_call");
            tx.commit().expect("commit assistant reupsert");
        }
        let tool_call_parent_after: Option<String> = conn
            .query_row(
                "SELECT parent_part_id FROM turn_parts WHERE id = ?1",
                params![tool_call_part_id],
                |row| row.get(0),
            )
            .expect("read tool_call parent after reupsert");
        assert_eq!(tool_call_parent_after.as_deref(), Some(assistant_id));

        // Separate transaction (targeted persist of tool message alone).
        let tool_message = StoredMessageRecord {
            content: r#"{"ok":true,"stdout":"file.txt"}"#.to_string(),
            completed_at_ms: Some(now + 5),
            created_at: now + 2,
            id: tool_message_id.clone(),
            role: "tool".to_string(),
            status: Some("done".to_string()),
            tool_call_id: Some(tool_call_id.to_string()),
            tool_name: Some("bash".to_string()),
            turn_id: Some("turn-1".to_string()),
            parts: vec![StoredMessageStepRecord {
                created_at_ms: Some(now + 2),
                id: tool_result_part_id.clone(),
                name: Some("bash".to_string()),
                output: Some(r#"{"ok":true,"stdout":"file.txt"}"#.to_string()),
                parent_part_id: Some(tool_call_part_id.clone()),
                status: Some("done".to_string()),
                tool_call_id: Some(tool_call_id.to_string()),
                r#type: "tool_result".to_string(),
                ..StoredMessageStepRecord::default()
            }],
            ..StoredMessageRecord::default()
        };

        {
            let tx = conn.transaction().expect("start tool write");
            let mut turn_indexes = load_turn_indexes(&tx, "session-1").expect("indexes");
            let mut inserted = HashSet::new();
            insert_message_part(
                &tx,
                &mut inserted,
                "session-1",
                &mut turn_indexes,
                &tool_message,
                Some("running"),
            )
            .expect("insert tool message with underscore id");
            tx.commit().expect("commit tool");
        }

        let (role, status): (String, String) = conn
            .query_row(
                "SELECT role, status FROM turn_parts WHERE id = ?1",
                params![tool_message_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read tool message anchor");
        assert_eq!(role, "tool");
        assert_eq!(status, "done");

        let (part_type, tool_output, parent_part_id, stored_tool_call_id): (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT part_type, tool_output, parent_part_id, tool_call_id FROM turn_parts WHERE id = ?1",
                params![tool_result_part_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read tool_result part");

        assert_eq!(part_type, "tool_result");
        assert_eq!(
            tool_output.as_deref(),
            Some(r#"{"ok":true,"stdout":"file.txt"}"#)
        );
        assert_eq!(parent_part_id.as_deref(), Some(tool_call_part_id.as_str()));
        assert_eq!(stored_tool_call_id.as_deref(), Some(tool_call_id));

        // Re-upsert without parent should keep existing parent link.
        let tool_message_without_parent = StoredMessageRecord {
            content: r#"{"ok":true,"stdout":"file.txt"}"#.to_string(),
            completed_at_ms: Some(now + 6),
            created_at: now + 2,
            id: tool_message_id.clone(),
            role: "tool".to_string(),
            status: Some("done".to_string()),
            tool_call_id: Some(tool_call_id.to_string()),
            tool_name: Some("bash".to_string()),
            turn_id: Some("turn-1".to_string()),
            parts: vec![StoredMessageStepRecord {
                created_at_ms: Some(now + 2),
                id: tool_result_part_id.clone(),
                name: Some("bash".to_string()),
                output: Some(r#"{"ok":true,"stdout":"file.txt"}"#.to_string()),
                parent_part_id: None,
                status: Some("done".to_string()),
                tool_call_id: Some(tool_call_id.to_string()),
                r#type: "tool_result".to_string(),
                ..StoredMessageStepRecord::default()
            }],
            ..StoredMessageRecord::default()
        };
        {
            let tx = conn.transaction().expect("start tool reupsert");
            let mut turn_indexes = load_turn_indexes(&tx, "session-1").expect("indexes");
            let mut inserted = HashSet::new();
            insert_message_part(
                &tx,
                &mut inserted,
                "session-1",
                &mut turn_indexes,
                &tool_message_without_parent,
                Some("running"),
            )
            .expect("reupsert tool message");
            tx.commit().expect("commit reupsert");
        }

        let parent_after: Option<String> = conn
            .query_row(
                "SELECT parent_part_id FROM turn_parts WHERE id = ?1",
                params![tool_result_part_id],
                |row| row.get(0),
            )
            .expect("read parent after reupsert");
        assert_eq!(parent_after.as_deref(), Some(tool_call_part_id.as_str()));
    }

    #[test]
    fn tool_result_parent_falls_back_to_tool_call_id_lookup() {
        let mut conn = migrated_memory_db();
        let now = now_unix_ms();
        insert_test_session(&conn);

        let tool_call_id = "call_01_fallbackParent";
        let tool_call_part_id = "message-assistant-aaa-tool-call-call_01_fallbackParent";

        {
            let tx = conn.transaction().expect("tx");
            let mut turn_indexes = load_turn_indexes(&tx, "session-1").expect("indexes");
            let mut inserted = HashSet::new();
            insert_message_part(
                &tx,
                &mut inserted,
                "session-1",
                &mut turn_indexes,
                &StoredMessageRecord {
                    created_at: now,
                    id: "message-assistant-aaa".to_string(),
                    role: "assistant".to_string(),
                    status: Some("done".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    parts: vec![StoredMessageStepRecord {
                        id: tool_call_part_id.to_string(),
                        name: Some("bash".to_string()),
                        input: Some("{}".to_string()),
                        status: Some("done".to_string()),
                        tool_call_id: Some(tool_call_id.to_string()),
                        r#type: "tool_call".to_string(),
                        ..StoredMessageStepRecord::default()
                    }],
                    ..StoredMessageRecord::default()
                },
                Some("running"),
            )
            .expect("assistant");
            tx.commit().expect("commit");
        }

        {
            let tx = conn.transaction().expect("tx tool");
            let mut turn_indexes = load_turn_indexes(&tx, "session-1").expect("indexes");
            let mut inserted = HashSet::new();
            insert_message_part(
                &tx,
                &mut inserted,
                "session-1",
                &mut turn_indexes,
                &StoredMessageRecord {
                    content: "done".to_string(),
                    created_at: now + 1,
                    id: format!("message-tool-{tool_call_id}"),
                    role: "tool".to_string(),
                    status: Some("done".to_string()),
                    tool_call_id: Some(tool_call_id.to_string()),
                    tool_name: Some("bash".to_string()),
                    turn_id: Some("turn-1".to_string()),
                    parts: vec![StoredMessageStepRecord {
                        id: format!("message-tool-{tool_call_id}-result"),
                        name: Some("bash".to_string()),
                        output: Some("done".to_string()),
                        // Wrong / missing parent id — resolve via tool_call_id.
                        parent_part_id: Some("missing-parent".to_string()),
                        status: Some("done".to_string()),
                        tool_call_id: Some(tool_call_id.to_string()),
                        r#type: "tool_result".to_string(),
                        ..StoredMessageStepRecord::default()
                    }],
                    ..StoredMessageRecord::default()
                },
                Some("running"),
            )
            .expect("tool without valid parent id");
            tx.commit().expect("commit tool");
        }

        let parent: Option<String> = conn
            .query_row(
                "SELECT parent_part_id FROM turn_parts WHERE id = ?1",
                params![format!("message-tool-{tool_call_id}-result")],
                |row| row.get(0),
            )
            .expect("parent");
        assert_eq!(parent.as_deref(), Some(tool_call_part_id));
    }

    #[test]
    fn finalized_turn_rejects_targeted_message_updates() {
        let mut conn = migrated_memory_db();
        let now = now_unix_ms();
        insert_test_session(&conn);
        conn.execute(
            "INSERT INTO turns (id, session_id, turn_index, status, created_at, updated_at) VALUES ('turn-final', 'session-1', 0, 'complete', ?1, ?1)",
            params![now as i64],
        )
        .expect("insert final turn");

        let tx = conn.transaction().expect("start targeted write");
        let error = ensure_active_turn_can_update(&tx, "turn-final")
            .expect_err("final turn rejects updates");

        assert!(error.contains("already finalized"));
    }

    #[test]
    fn resolve_finalize_turn_result_closes_running_and_is_idempotent() {
        assert!(resolve_finalize_turn_result("turn-1", "complete", 1, None).is_ok());
        assert!(resolve_finalize_turn_result("turn-1", "complete", 0, Some("complete")).is_ok());
        assert!(resolve_finalize_turn_result("turn-1", "complete", 0, Some("interrupted")).is_ok());
        assert!(resolve_finalize_turn_result("turn-1", "error", 0, Some("error")).is_ok());

        let missing = resolve_finalize_turn_result("turn-missing", "complete", 0, None)
            .expect_err("missing turn");
        assert!(missing.contains("not found"));

        let bad = resolve_finalize_turn_result("turn-1", "complete", 0, Some("running"))
            .expect_err("still running after zero updates");
        assert!(bad.contains("from status running"));
    }

    #[test]
    fn process_records_store_bounded_output_and_interruption_status() {
        let conn = migrated_memory_db();
        let now = now_unix_ms() as i64;

        insert_test_session(&conn);
        conn.execute(
            "INSERT INTO processes (id, session_id, command, cwd, pid, status, started_at, stdout_tail, stderr_tail) VALUES ('process-1', 'session-1', 'npm run dev', '/tmp/project', 123, 'running', ?1, '', '')",
            params![now],
        )
        .expect("insert process");

        let stdout_tail = append_tail("", &"a".repeat(PROCESS_TAIL_BYTES + 32), PROCESS_TAIL_BYTES);
        conn.execute(
            "UPDATE processes SET stdout_tail = ?1, status = 'interrupted', ended_at = ?2 WHERE id = 'process-1'",
            params![stdout_tail, now + 1],
        )
        .expect("update process");

        let process = conn
            .query_row(
                &format!("{} WHERE id = 'process-1'", process_select_sql()),
                [],
                row_to_process_payload,
            )
            .expect("read process");

        assert_eq!(process.status, "interrupted");
        assert_eq!(process.stdout_tail.len(), PROCESS_TAIL_BYTES);
        assert_eq!(process.ended_at_ms, Some((now + 1) as u64));
    }

    #[test]
    fn insert_process_stores_turn_and_tool_call_ids() {
        let conn = migrated_memory_db();
        insert_test_session(&conn);
        ensure_process_link_columns(&conn).expect("link columns");

        conn.execute(
            "
            INSERT INTO processes (
              id, session_id, command, cwd, pid, status, started_at,
              stdout_tail, stderr_tail, turn_id, tool_call_id
            ) VALUES (
              'process-linked', 'session-1', 'npm run dev', '/tmp', 9, 'running', ?1,
              '', '', 'turn-abc', 'call_00_xyz'
            )
            ",
            params![now_unix_ms() as i64],
        )
        .expect("insert linked process");

        let process = conn
            .query_row(
                &format!("{} WHERE id = 'process-linked'", process_select_sql()),
                [],
                row_to_process_payload,
            )
            .expect("read linked process");

        assert_eq!(process.turn_id.as_deref(), Some("turn-abc"));
        assert_eq!(process.tool_call_id.as_deref(), Some("call_00_xyz"));
        assert_eq!(process.session_id, "session-1");
    }

    #[test]
    fn composer_state_persists_draft_and_queue_order() {
        let mut conn = migrated_memory_db();
        insert_test_session(&conn);

        save_composer_state_with_conn(
            &mut conn,
            SaveComposerStateInput {
                draft_text: "continue refactor".to_string(),
                queued_messages: vec![
                    PersistedQueuedMessageInput {
                        attachments: Vec::new(),
                        content: "first queued".to_string(),
                        id: "queue-1".to_string(),
                        status: Some("queued".to_string()),
                    },
                    PersistedQueuedMessageInput {
                        attachments: vec![PersistedPreviewFileInput {
                            content: Some("hello".to_string()),
                            content_hash: None,
                            id: "file-1".to_string(),
                            image_src: None,
                            is_sensitive: None,
                            kind: "text".to_string(),
                            language: Some("txt".to_string()),
                            mime_type: None,
                            name: "note.txt".to_string(),
                            original_path: None,
                            path: "Attachments/note.txt".to_string(),
                            preview_metadata: None,
                            real_path: None,
                            size_bytes: None,
                            summary: "text file".to_string(),
                        }],
                        content: "second queued".to_string(),
                        id: "queue-2".to_string(),
                        status: Some("queued".to_string()),
                    },
                ],
                session_id: "session-1".to_string(),
            },
        )
        .expect("save composer state");

        let state = load_composer_state_from_conn(&conn, "session-1").expect("load composer state");
        assert_eq!(state.draft_text, "continue refactor");
        assert_eq!(state.queued_messages.len(), 2);
        assert_eq!(state.queued_messages[0].id, "queue-1");
        assert_eq!(state.queued_messages[1].id, "queue-2");
        assert_eq!(state.queued_messages[1].attachments[0].name, "note.txt");
    }

    #[test]
    fn composer_state_clears_empty_draft_and_replaces_queue() {
        let mut conn = migrated_memory_db();
        insert_test_session(&conn);

        save_composer_state_with_conn(
            &mut conn,
            SaveComposerStateInput {
                draft_text: "old draft".to_string(),
                queued_messages: vec![PersistedQueuedMessageInput {
                    attachments: Vec::new(),
                    content: "old queued".to_string(),
                    id: "queue-old".to_string(),
                    status: None,
                }],
                session_id: "session-1".to_string(),
            },
        )
        .expect("save initial composer state");

        save_composer_state_with_conn(
            &mut conn,
            SaveComposerStateInput {
                draft_text: "   ".to_string(),
                queued_messages: vec![PersistedQueuedMessageInput {
                    attachments: Vec::new(),
                    content: "new queued".to_string(),
                    id: "queue-new".to_string(),
                    status: None,
                }],
                session_id: "session-1".to_string(),
            },
        )
        .expect("replace composer state");

        let state = load_composer_state_from_conn(&conn, "session-1").expect("load composer state");
        assert_eq!(state.draft_text, "");
        assert_eq!(state.queued_messages.len(), 1);
        assert_eq!(state.queued_messages[0].id, "queue-new");
        assert_eq!(state.queued_messages[0].status, "queued");
    }

    #[test]
    fn truncate_session_transcript_deletes_turns_not_kept() {
        let mut conn = migrated_memory_db();
        insert_test_session(&conn);
        let now = now_unix_ms() as i64;

        for (turn_id, turn_index) in [("turn-a", 0), ("turn-b", 1), ("turn-c", 2)] {
            conn.execute(
                "INSERT INTO turns (id, session_id, turn_index, status, created_at, updated_at) VALUES (?1, 'session-1', ?2, 'complete', ?3, ?3)",
                params![turn_id, turn_index, now],
            )
            .expect("insert turn");
            conn.execute(
                "INSERT INTO turn_parts (id, turn_id, part_type, role, part_index, status, created_at, updated_at) VALUES (?1, ?2, 'message', 'user', 0, 'done', ?3, ?3)",
                params![format!("{turn_id}-part"), turn_id, now],
            )
            .expect("insert part");
        }

        let tx = conn.transaction().expect("tx");
        // Inline the keep logic for unit test without open_database.
        let keep = HashSet::from(["turn-a".to_string()]);
        let existing: Vec<String> = {
            let mut statement = tx
                .prepare("SELECT id FROM turns WHERE session_id = 'session-1'")
                .unwrap();
            statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .filter_map(|row| row.ok())
                .collect()
        };
        for turn_id in existing {
            if !keep.contains(&turn_id) {
                tx.execute("DELETE FROM turns WHERE id = ?1", params![turn_id])
                    .unwrap();
            }
        }
        tx.commit().unwrap();

        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM turns WHERE session_id = 'session-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 1);
        let parts: i64 = conn
            .query_row("SELECT COUNT(*) FROM turn_parts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(parts, 1, "parts cascade with turn delete");
    }

    #[test]
    fn delete_stale_refuses_empty_snapshot_when_turns_exist() {
        let mut conn = migrated_memory_db();
        insert_test_session(&conn);
        let now = now_unix_ms() as i64;
        conn.execute(
            "INSERT INTO turns (id, session_id, turn_index, status, created_at, updated_at) VALUES ('turn-x', 'session-1', 0, 'complete', ?1, ?1)",
            params![now],
        )
        .unwrap();

        let tx = conn.transaction().unwrap();
        let err = delete_stale_transcript_rows(&tx, "session-1", &HashSet::new(), &HashSet::new())
            .expect_err("must refuse empty wipe");
        assert!(err.contains("empty snapshot"), "{err}");
    }

    #[test]
    fn unfinished_streaming_message_becomes_interrupted_not_done() {
        let record = StoredMessageRecord {
            content: "partial answer".to_string(),
            created_at: 1_000,
            id: "message-assistant-1".to_string(),
            role: "assistant".to_string(),
            status: Some("streaming".to_string()),
            parts: vec![StoredMessageStepRecord {
                content: Some("partial answer".to_string()),
                id: "part-1".to_string(),
                status: Some("streaming".to_string()),
                r#type: "content".to_string(),
                ..StoredMessageStepRecord::default()
            }],
            ..StoredMessageRecord::default()
        };

        let recovered = recover_incomplete_message(record);
        assert_eq!(recovered.status.as_deref(), Some("interrupted"));
        assert_ne!(recovered.status.as_deref(), Some("done"));
        assert_eq!(recovered.content, "partial answer");
        assert_eq!(recovered.parts[0].status.as_deref(), Some("interrupted"));
        assert_eq!(recovered.completed_at_ms, Some(1_000));
    }

    #[test]
    fn empty_streaming_assistant_gets_interrupted_fallback_text() {
        let record = StoredMessageRecord {
            content: String::new(),
            created_at: 2_000,
            id: "message-assistant-2".to_string(),
            role: "assistant".to_string(),
            status: Some("streaming".to_string()),
            parts: vec![StoredMessageStepRecord {
                id: "part-empty".to_string(),
                status: Some("streaming".to_string()),
                r#type: "content".to_string(),
                ..StoredMessageStepRecord::default()
            }],
            ..StoredMessageRecord::default()
        };

        let recovered = recover_incomplete_message(record);
        assert_eq!(recovered.status.as_deref(), Some("interrupted"));
        assert_eq!(recovered.content, "Response interrupted.");
        assert_eq!(recovered.parts[0].status.as_deref(), Some("interrupted"));
    }

    #[test]
    fn done_messages_are_unchanged_by_stream_recovery() {
        let record = StoredMessageRecord {
            content: "finished".to_string(),
            created_at: 3_000,
            id: "message-assistant-3".to_string(),
            role: "assistant".to_string(),
            status: Some("done".to_string()),
            parts: vec![StoredMessageStepRecord {
                content: Some("finished".to_string()),
                id: "part-done".to_string(),
                status: Some("done".to_string()),
                r#type: "content".to_string(),
                ..StoredMessageStepRecord::default()
            }],
            ..StoredMessageRecord::default()
        };

        let recovered = recover_incomplete_message(record.clone());
        assert_eq!(recovered.status.as_deref(), Some("done"));
        assert_eq!(recovered.content, "finished");
        assert_eq!(recovered.parts[0].status.as_deref(), Some("done"));
    }

    #[test]
    fn mark_compacted_turns_sets_flags_for_complete_turns_only() {
        let mut conn = migrated_memory_db();
        let now = now_unix_ms() as i64;
        insert_test_session(&conn);
        conn.execute(
            "INSERT INTO turns (id, session_id, turn_index, status, compacted, created_at, updated_at)
             VALUES ('turn-a', 'session-1', 0, 'complete', 0, ?1, ?1)",
            params![now],
        )
        .expect("insert complete turn a");
        conn.execute(
            "INSERT INTO turns (id, session_id, turn_index, status, compacted, created_at, updated_at)
             VALUES ('turn-b', 'session-1', 1, 'complete', 0, ?1, ?1)",
            params![now],
        )
        .expect("insert complete turn b");
        conn.execute(
            "INSERT INTO turns (id, session_id, turn_index, status, compacted, created_at, updated_at)
             VALUES ('turn-running', 'session-1', 2, 'running', 0, ?1, ?1)",
            params![now],
        )
        .expect("insert running turn");

        {
            let tx = conn.transaction().expect("start mark tx");
            mark_compacted_turns(
                &tx,
                "session-1",
                &[
                    "turn-a".to_string(),
                    "turn-running".to_string(),
                    "missing-turn".to_string(),
                ],
            )
            .expect("mark compacted turns");
            tx.commit().expect("commit mark");
        }

        let compacted_ids = read_compacted_turn_ids(&conn, "session-1").expect("read flags");
        assert_eq!(compacted_ids, vec!["turn-a".to_string()]);

        let turn_b_flag: i64 = conn
            .query_row(
                "SELECT compacted FROM turns WHERE id = 'turn-b'",
                [],
                |row| row.get(0),
            )
            .expect("read turn-b flag");
        let running_flag: i64 = conn
            .query_row(
                "SELECT compacted FROM turns WHERE id = 'turn-running'",
                [],
                |row| row.get(0),
            )
            .expect("read running flag");
        assert_eq!(turn_b_flag, 0, "unlisted complete turn stays uncompacted");
        assert_eq!(running_flag, 0, "running turns are not marked compacted");
    }

    #[test]
    fn pending_and_running_parts_become_interrupted_on_load() {
        let record = StoredMessageRecord {
            content: String::new(),
            created_at: 1_000,
            id: "message-assistant-mixed".to_string(),
            role: "assistant".to_string(),
            status: Some("done".to_string()),
            parts: vec![
                StoredMessageStepRecord {
                    content: Some("done text".to_string()),
                    id: "part-done".to_string(),
                    status: Some("done".to_string()),
                    r#type: "content".to_string(),
                    ..StoredMessageStepRecord::default()
                },
                StoredMessageStepRecord {
                    id: "part-pending-tool".to_string(),
                    status: Some("pending".to_string()),
                    r#type: "tool_call".to_string(),
                    name: Some("bash".to_string()),
                    tool_call_id: Some("call-1".to_string()),
                    ..StoredMessageStepRecord::default()
                },
                StoredMessageStepRecord {
                    id: "part-running-result".to_string(),
                    status: Some("running".to_string()),
                    r#type: "tool_result".to_string(),
                    tool_call_id: Some("call-1".to_string()),
                    ..StoredMessageStepRecord::default()
                },
            ],
            tool_calls: vec![StoredToolCallRecord {
                id: "call-1".to_string(),
                input: Some("{}".to_string()),
                name: "bash".to_string(),
                status: Some("running".to_string()),
            }],
            ..StoredMessageRecord::default()
        };

        let recovered = recover_incomplete_message(record);
        assert_eq!(recovered.status.as_deref(), Some("interrupted"));
        assert_eq!(recovered.parts[0].status.as_deref(), Some("done"));
        assert_eq!(recovered.parts[1].status.as_deref(), Some("interrupted"));
        assert_eq!(recovered.parts[2].status.as_deref(), Some("interrupted"));
        assert_eq!(
            recovered.tool_calls[0].status.as_deref(),
            Some("interrupted")
        );
    }

    #[test]
    fn user_message_interrupted_status_repairs_to_done_on_load() {
        let record = StoredMessageRecord {
            content: "hello".to_string(),
            created_at: 1_000,
            id: "message-user-1".to_string(),
            role: "user".to_string(),
            status: Some("interrupted".to_string()),
            ..StoredMessageRecord::default()
        };

        let recovered = recover_incomplete_message(record);
        assert_eq!(recovered.status.as_deref(), Some("done"));
        assert_eq!(recovered.content, "hello");
    }

    #[test]
    fn interrupt_running_turns_on_load_closes_stuck_turns() {
        let conn = migrated_memory_db();
        let now = now_unix_ms() as i64;
        insert_test_session(&conn);
        conn.execute(
            "INSERT INTO turns (id, session_id, turn_index, status, created_at, updated_at)
             VALUES ('turn-running', 'session-1', 0, 'running', ?1, ?1)",
            params![now],
        )
        .expect("insert running turn");
        conn.execute(
            "INSERT INTO turns (id, session_id, turn_index, status, created_at, updated_at)
             VALUES ('turn-complete', 'session-1', 1, 'complete', ?1, ?1)",
            params![now],
        )
        .expect("insert complete turn");

        interrupt_running_turns_on_load(&conn, "session-1").expect("recover turns");

        let running_status: String = conn
            .query_row(
                "SELECT status FROM turns WHERE id = 'turn-running'",
                [],
                |row| row.get(0),
            )
            .expect("read running");
        let complete_status: String = conn
            .query_row(
                "SELECT status FROM turns WHERE id = 'turn-complete'",
                [],
                |row| row.get(0),
            )
            .expect("read complete");
        assert_eq!(running_status, "interrupted");
        assert_eq!(complete_status, "complete");
    }

    #[test]
    fn turn_budget_summary_writes_columns_on_real_turn_not_synthetic_turn() {
        let mut conn = migrated_memory_db();
        let now = now_unix_ms() as i64;
        insert_test_session(&conn);
        conn.execute(
            "INSERT INTO turns (id, session_id, turn_index, status, created_at, updated_at)
             VALUES ('turn-real', 'session-1', 0, 'running', ?1, ?1)",
            params![now],
        )
        .expect("insert real turn");
        // Legacy synthetic summary turn should be deleted on upsert.
        conn.execute(
            "INSERT INTO turns (id, session_id, turn_index, status, created_at, updated_at)
             VALUES ('summary-turn-real', 'session-1', 1, 'complete', ?1, ?1)",
            params![now],
        )
        .expect("insert legacy summary turn");

        {
            let tx = conn.transaction().expect("tx");
            let mut turn_indexes = load_turn_indexes(&tx, "session-1").expect("indexes");
            upsert_turn_budget_summary(
                &tx,
                "session-1",
                &mut turn_indexes,
                &StoredTurnSummaryRecord {
                    completed_at_ms: now as u64 + 10,
                    estimated_tokens_image_capable: 120,
                    estimated_tokens_text_only: 100,
                    estimator_version: 4,
                    message_ids: vec!["m1".to_string(), "m2".to_string()],
                    replay_message_count_image_capable: 3,
                    replay_message_count_text_only: 2,
                    turn_id: "turn-real".to_string(),
                },
            )
            .expect("upsert budget");
            tx.commit().expect("commit");
        }

        let status: String = conn
            .query_row(
                "SELECT status FROM turns WHERE id = 'turn-real'",
                [],
                |row| row.get(0),
            )
            .expect("status");
        assert_eq!(status, "running", "budget upsert must not force complete");

        let text_tokens: i64 = conn
            .query_row(
                "SELECT estimated_tokens_text_only FROM turns WHERE id = 'turn-real'",
                [],
                |row| row.get(0),
            )
            .expect("text tokens");
        let version: i64 = conn
            .query_row(
                "SELECT estimator_version FROM turns WHERE id = 'turn-real'",
                [],
                |row| row.get(0),
            )
            .expect("version");
        let message_ids: String = conn
            .query_row(
                "SELECT summary_message_ids FROM turns WHERE id = 'turn-real'",
                [],
                |row| row.get(0),
            )
            .expect("message ids");
        assert_eq!(text_tokens, 100);
        assert_eq!(version, 4);
        assert!(message_ids.contains("m1"));

        let legacy_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM turns WHERE id LIKE 'summary-%'",
                [],
                |row| row.get(0),
            )
            .expect("legacy count");
        assert_eq!(legacy_count, 0, "synthetic summary turns removed");

        let loaded = load_turn_budget_summaries(&conn, "session-1").expect("load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].turn_id, "turn-real");
        assert_eq!(loaded[0].estimated_tokens_text_only, 100);
        assert_eq!(
            loaded[0].message_ids,
            vec!["m1".to_string(), "m2".to_string()]
        );
    }
}
