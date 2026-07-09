use serde::{de::DeserializeOwned, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use super::types::{StoredProjectsFile, StoredSettingsFile, StoredVersionFile};

pub const CURRENT_SCHEMA_VERSION: u32 = 2;

pub fn validate_storage_id(kind: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("The {kind} id cannot be empty."));
    }

    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Ok(());
    }

    Err(format!(
        "The {kind} id contains unsupported characters. Use only letters, numbers, and hyphens."
    ))
}

pub fn wizzle_root_dir() -> Result<PathBuf, String> {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .or_else(|| {
            let drive = env::var_os("HOMEDRIVE")?;
            let path = env::var_os("HOMEPATH")?;
            let mut combined = PathBuf::from(drive);
            combined.push(path);
            Some(combined.into_os_string())
        })
        .ok_or_else(|| "Could not resolve the home directory for Wizzle storage.".to_string())?;

    Ok(PathBuf::from(home).join(".wizzle"))
}

pub fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| {
        format!(
            "Could not create Wizzle storage directory {}: {error}",
            path.display()
        )
    })
}

#[allow(dead_code)]
pub fn read_json_or_default<T>(path: &Path) -> Result<T, String>
where
    T: DeserializeOwned + Default,
{
    if !path.exists() {
        return Ok(T::default());
    }

    let contents = fs::read_to_string(path).map_err(|error| {
        format!(
            "Could not read Wizzle data from {}: {error}",
            path.display()
        )
    })?;

    match serde_json::from_str(&contents) {
        Ok(value) => Ok(value),
        Err(_error) => {
            quarantine_corrupt_file(path);
            Ok(T::default())
        }
    }
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }

    let json = serde_json::to_string_pretty(value).map_err(|error| {
        format!(
            "Could not serialize Wizzle data for {}: {error}",
            path.display()
        )
    })?;
    let temporary_path = path.with_extension("json.tmp");

    fs::write(&temporary_path, json).map_err(|error| {
        format!(
            "Could not write temporary Wizzle data to {}: {error}",
            temporary_path.display()
        )
    })?;

    fs::rename(&temporary_path, path).map_err(|error| {
        format!(
            "Could not finalize Wizzle data at {}: {error}",
            path.display()
        )
    })
}

#[allow(dead_code)]
fn quarantine_corrupt_file(path: &Path) {
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return;
    };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let backup_path = path.with_file_name(format!("{file_name}.corrupt-{timestamp}"));

    let _ = fs::rename(path, backup_path);
}

pub fn state_dir(root: &Path) -> PathBuf {
    root.join("state")
}

pub fn projects_dir(root: &Path) -> PathBuf {
    root.join("projects")
}

pub fn settings_path(root: &Path) -> PathBuf {
    state_dir(root).join("settings.json")
}

pub fn projects_index_path(root: &Path) -> PathBuf {
    state_dir(root).join("projects.json")
}

pub fn version_path(root: &Path) -> PathBuf {
    state_dir(root).join("version.json")
}

pub fn database_path(root: &Path) -> PathBuf {
    root.join("wizzle.db")
}

pub fn sessions_dir(root: &Path) -> PathBuf {
    root.join("sessions")
}

pub fn session_cache_dir(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    validate_storage_id("session", session_id)?;
    Ok(sessions_dir(root).join(session_id).join(".cache"))
}

pub fn sqlite_session_dir(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    validate_storage_id("session", session_id)?;
    Ok(sessions_dir(root).join(session_id))
}

pub fn sqlite_session_attachments_dir(root: &Path, session_id: &str) -> Result<PathBuf, String> {
    Ok(sqlite_session_dir(root, session_id)?.join("attachments"))
}

#[allow(dead_code)]
pub fn legacy_projects_path(root: &Path) -> PathBuf {
    root.join("projects.json")
}

#[allow(dead_code)]
pub fn legacy_settings_path(root: &Path) -> PathBuf {
    root.join("settings.json")
}

#[allow(dead_code)]
pub fn legacy_sessions_dir(root: &Path) -> PathBuf {
    root.join("sessions")
}

#[allow(dead_code)]
pub fn project_dir(root: &Path, project_id: &str) -> Result<PathBuf, String> {
    validate_storage_id("project", project_id)?;
    Ok(projects_dir(root).join(project_id))
}

#[allow(dead_code)]
pub fn project_metadata_path(root: &Path, project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(root, project_id)?.join("project.json"))
}

#[allow(dead_code)]
pub fn project_sessions_dir(root: &Path, project_id: &str) -> Result<PathBuf, String> {
    Ok(project_dir(root, project_id)?.join("sessions"))
}

#[allow(dead_code)]
pub fn session_dir(root: &Path, project_id: &str, session_id: &str) -> Result<PathBuf, String> {
    validate_storage_id("session", session_id)?;
    Ok(project_sessions_dir(root, project_id)?.join(session_id))
}

#[allow(dead_code)]
pub fn session_metadata_path(
    root: &Path,
    project_id: &str,
    session_id: &str,
) -> Result<PathBuf, String> {
    Ok(session_dir(root, project_id, session_id)?.join("session.json"))
}

#[allow(dead_code)]
pub fn session_messages_path(
    root: &Path,
    project_id: &str,
    session_id: &str,
) -> Result<PathBuf, String> {
    Ok(session_dir(root, project_id, session_id)?.join("messages.jsonl"))
}

#[allow(dead_code)]
pub fn legacy_session_messages_path(
    root: &Path,
    project_id: &str,
    session_id: &str,
) -> Result<PathBuf, String> {
    Ok(session_dir(root, project_id, session_id)?.join("messages.json"))
}

#[allow(dead_code)]
pub fn session_attachments_dir(
    root: &Path,
    project_id: &str,
    session_id: &str,
) -> Result<PathBuf, String> {
    Ok(session_dir(root, project_id, session_id)?.join("attachments"))
}

pub fn ensure_workspace_storage() -> Result<PathBuf, String> {
    let root = wizzle_root_dir()?;
    ensure_dir(&root)?;
    ensure_dir(&state_dir(&root))?;
    ensure_dir(&projects_dir(&root))?;
    ensure_dir(&sessions_dir(&root))?;

    let version_path = version_path(&root);
    if !version_path.exists() {
        write_json(
            &version_path,
            &StoredVersionFile {
                schema_version: CURRENT_SCHEMA_VERSION,
            },
        )?;
    }

    let settings_path = settings_path(&root);
    if !settings_path.exists() {
        write_json(&settings_path, &StoredSettingsFile::default())?;
    }

    let projects_path = projects_index_path(&root);
    if !projects_path.exists() {
        write_json(&projects_path, &StoredProjectsFile::default())?;
    }

    Ok(root)
}
