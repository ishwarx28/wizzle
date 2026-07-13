mod attachments;
pub(crate) mod paths;
pub(crate) mod sqlite_repository;
mod types;

use std::sync::Mutex;
use std::{
    env,
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
};

use tauri::{State, Window};

use crate::agent::AgentRuntimeState;

pub use attachments::{build_attachment_preview_from_bytes, read_attachment_previews};
pub use types::WorkspaceSnapshotPayload;
use types::{
    AppendOrUpdateMessageInput, DeleteSessionInput, FinalizeTurnInput, LoadComposerStateInput,
    LoadTodoStateInput, LoadWorkspaceSessionInput, PersistSessionMetadataInput,
    PersistWorkspaceSessionInput, RenameSessionInput, ResolveToolPathCandidatesInput,
    ResolvedToolPathCandidatePayload, SaveComposerStateInput, SaveTodoStateInput,
    SaveWorkspaceSettingsInput, SetProjectExpandedInput, TodoStatePayload,
    TruncateSessionTranscriptInput, UpdateSessionSelectionInput, UpdateSessionTitleInput,
    UpsertSessionEventInput, UpsertTurnSummaryInput, WorkspaceComposerStatePayload,
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

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
        .or_else(|| {
            let drive = env::var_os("HOMEDRIVE")?;
            let path = env::var_os("HOMEPATH")?;
            let mut home = PathBuf::from(drive);
            home.push(path);
            Some(home)
        })
}

fn env_path_value(name: &str, cwd: &Path) -> Option<String> {
    match name {
        "PWD" => Some(cwd.to_string_lossy().to_string()),
        "HOME" => home_dir().map(|path| path.to_string_lossy().to_string()),
        "TMPDIR" | "TMP" | "TEMP" => env::var_os(name)
            .map(PathBuf::from)
            .or_else(|| Some(env::temp_dir()))
            .map(|path| path.to_string_lossy().to_string()),
        _ => env::var_os(name).map(|value| value.to_string_lossy().to_string()),
    }
}

fn parse_braced_variable(value: &str) -> (&str, Option<&str>) {
    if let Some(index) = value.find(":-") {
        return (&value[..index], Some(&value[index + 2..]));
    }

    if let Some(index) = value.find('-') {
        return (&value[..index], Some(&value[index + 1..]));
    }

    (value, None)
}

fn expand_shell_path_value(value: &str, cwd: &Path) -> (String, bool) {
    let mut result = String::new();
    let mut has_unexpanded = false;
    let mut index = 0;

    let expanded_home = if value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
        home_dir().map(|home| {
            if value == "~" {
                home.to_string_lossy().to_string()
            } else {
                home.join(&value[2..]).to_string_lossy().to_string()
            }
        })
    } else {
        None
    };

    let source = expanded_home.as_deref().unwrap_or(value);
    let chars = source.char_indices().collect::<Vec<_>>();

    while index < chars.len() {
        let (byte_index, character) = chars[index];

        if character == '$' {
            let next = chars.get(index + 1).copied();

            if let Some((_, '{')) = next {
                let Some((content_start, _)) = chars.get(index + 2).copied() else {
                    result.push(character);
                    index += 1;
                    continue;
                };
                let mut end_index = index + 2;
                while end_index < chars.len() && chars[end_index].1 != '}' {
                    end_index += 1;
                }

                if end_index < chars.len() {
                    let content_end = chars[end_index].0;
                    let (name, default_value) =
                        parse_braced_variable(&source[content_start..content_end]);
                    if !name.is_empty()
                        && name
                            .chars()
                            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
                    {
                        if let Some(value) = env_path_value(name, cwd) {
                            result.push_str(&value);
                        } else if let Some(default_value) = default_value {
                            result.push_str(default_value);
                        } else {
                            has_unexpanded = true;
                            let token_end = chars
                                .get(end_index + 1)
                                .map(|(offset, _)| *offset)
                                .unwrap_or_else(|| source.len());
                            result.push_str(&source[byte_index..token_end]);
                        }
                        index = end_index + 1;
                        continue;
                    }
                }
            } else if let Some((name_start, next_char)) = next {
                if next_char.is_ascii_alphabetic() || next_char == '_' {
                    let mut end_index = index + 1;
                    while end_index < chars.len()
                        && (chars[end_index].1.is_ascii_alphanumeric() || chars[end_index].1 == '_')
                    {
                        end_index += 1;
                    }
                    let name_end = chars
                        .get(end_index)
                        .map(|(offset, _)| *offset)
                        .unwrap_or_else(|| source.len());
                    let name = &source[name_start..name_end];

                    if let Some(value) = env_path_value(name, cwd) {
                        result.push_str(&value);
                    } else {
                        has_unexpanded = true;
                        result.push_str(&source[byte_index..name_end]);
                    }
                    index = end_index;
                    continue;
                }
            }
        }

        result.push(character);
        index += 1;
    }

    let mut windows_expanded = String::new();
    let mut windows_index = 0;
    while let Some(start) = result[windows_index..].find('%') {
        let absolute_start = windows_index + start;
        windows_expanded.push_str(&result[windows_index..absolute_start]);
        let Some(end) = result[absolute_start + 1..].find('%') else {
            windows_expanded.push_str(&result[absolute_start..]);
            windows_index = result.len();
            break;
        };
        let absolute_end = absolute_start + 1 + end;
        let name = &result[absolute_start + 1..absolute_end];

        if !name.is_empty() {
            if let Some(value) = env_path_value(name, cwd) {
                windows_expanded.push_str(&value);
            } else {
                has_unexpanded = true;
                windows_expanded.push_str(&result[absolute_start..=absolute_end]);
            }
        }
        windows_index = absolute_end + 1;
    }
    windows_expanded.push_str(&result[windows_index..]);

    (windows_expanded, has_unexpanded)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                let _ = normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
        }
    }

    normalized
}

fn join_against_base(base: &Path, requested_path: &str) -> PathBuf {
    let raw_path = PathBuf::from(requested_path);

    if raw_path.is_absolute() {
        normalize_path(&raw_path)
    } else {
        normalize_path(&base.join(raw_path))
    }
}

fn canonicalize_existing_prefix(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return fs::canonicalize(path)
            .map_err(|error| format!("Could not resolve {}: {error}", path.display()));
    }

    let mut current = path.to_path_buf();
    let mut missing_components: Vec<OsString> = Vec::new();

    while !current.exists() {
        let file_name = current
            .file_name()
            .ok_or_else(|| format!("Could not resolve {}.", path.display()))?
            .to_os_string();
        missing_components.push(file_name);
        current = current
            .parent()
            .ok_or_else(|| format!("Could not resolve {}.", path.display()))?
            .to_path_buf();
    }

    let mut resolved = fs::canonicalize(&current)
        .map_err(|error| format!("Could not resolve {}: {error}", current.display()))?;

    for component in missing_components.iter().rev() {
        resolved.push(component);
    }

    Ok(normalize_path(&resolved))
}

fn path_stays_inside_root(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

fn normalized_display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn is_safe_external_path(path: &Path) -> bool {
    let normalized = normalized_display_path(path);
    let trimmed = normalized.trim_end_matches('/');

    matches!(
        trimmed,
        "/dev" | "/tmp" | "/var/tmp" | "/private/tmp" | "/private/var/tmp"
    ) || normalized.starts_with("/dev/")
        || normalized.starts_with("/tmp/")
        || normalized.starts_with("/var/tmp/")
        || normalized.starts_with("/private/tmp/")
        || normalized.starts_with("/private/var/tmp/")
}

fn resolve_base_dir(project_root: &Path, cwd: Option<&str>) -> PathBuf {
    let Some(cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) else {
        return project_root.to_path_buf();
    };
    let (expanded_cwd, has_unexpanded) = expand_shell_path_value(cwd, project_root);

    if has_unexpanded {
        return project_root.to_path_buf();
    }

    let cwd_path = join_against_base(project_root, &expanded_cwd);
    canonicalize_existing_prefix(&cwd_path).unwrap_or(cwd_path)
}

fn resolve_tool_path_candidate(
    project_root: &Path,
    base_dir: &Path,
    raw_path: String,
) -> ResolvedToolPathCandidatePayload {
    let (expanded_path, has_unexpanded_variables) = expand_shell_path_value(&raw_path, base_dir);
    let lexical_path = join_against_base(base_dir, &expanded_path);

    if has_unexpanded_variables {
        return ResolvedToolPathCandidatePayload {
            error: None,
            expanded_path: Some(expanded_path),
            has_unexpanded_variables,
            is_inside_project_root: None,
            is_safe_external: false,
            raw_path,
            real_path: None,
            resolved_path: Some(lexical_path.to_string_lossy().to_string()),
        };
    }

    match canonicalize_existing_prefix(&lexical_path) {
        Ok(real_path) => {
            let is_inside_project_root = path_stays_inside_root(project_root, &real_path);
            let is_safe_external = is_safe_external_path(&real_path);
            ResolvedToolPathCandidatePayload {
                error: None,
                expanded_path: Some(expanded_path),
                has_unexpanded_variables: false,
                is_inside_project_root: Some(is_inside_project_root),
                is_safe_external,
                raw_path,
                real_path: Some(real_path.to_string_lossy().to_string()),
                resolved_path: Some(lexical_path.to_string_lossy().to_string()),
            }
        }
        Err(error) => {
            let is_inside_project_root = path_stays_inside_root(project_root, &lexical_path);
            let is_safe_external = is_safe_external_path(&lexical_path);
            ResolvedToolPathCandidatePayload {
                error: Some(error),
                expanded_path: Some(expanded_path),
                has_unexpanded_variables: false,
                is_inside_project_root: Some(is_inside_project_root),
                is_safe_external,
                raw_path,
                real_path: None,
                resolved_path: Some(lexical_path.to_string_lossy().to_string()),
            }
        }
    }
}

#[tauri::command]
pub fn resolve_tool_path_candidates(
    input: ResolveToolPathCandidatesInput,
) -> Result<Vec<ResolvedToolPathCandidatePayload>, String> {
    let project_root = fs::canonicalize(&input.project_root)
        .unwrap_or_else(|_| normalize_path(Path::new(&input.project_root)));
    let base_dir = resolve_base_dir(&project_root, input.cwd.as_deref());

    Ok(input
        .candidates
        .into_iter()
        .map(|candidate| resolve_tool_path_candidate(&project_root, &base_dir, candidate))
        .collect())
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
pub fn load_todo_state(
    input: LoadTodoStateInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<Option<TodoStatePayload>, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::load_todo_state(input)
}

#[tauri::command]
pub fn save_todo_state(
    input: SaveTodoStateInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::save_todo_state(input)
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
pub fn check_project_root_exists(
    project_id: String,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<bool, String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    let project_root = sqlite_repository::resolve_project_root(&project_id)?;

    match fs::metadata(&project_root) {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "Could not inspect project root {}: {error}",
            project_root.display()
        )),
    }
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
pub fn upsert_session_event(
    input: UpsertSessionEventInput,
    lock: State<'_, WorkspaceStorageLock>,
) -> Result<(), String> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| "Could not access Wizzle workspace storage.".to_string())?;
    sqlite_repository::upsert_session_event(input)
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

#[cfg(test)]
mod tests {
    use super::{resolve_tool_path_candidates, ResolveToolPathCandidatesInput};
    use std::fs;
    use uuid::Uuid;

    fn temporary_root(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("wizzle-resolve-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temporary root");
        fs::canonicalize(root).expect("canonical temporary root")
    }

    #[test]
    fn path_resolver_expands_pwd_relative_to_command_cwd() {
        let root = temporary_root("pwd");
        fs::create_dir_all(root.join("src")).expect("create src");
        fs::write(root.join("README.md"), "readme").expect("write readme");

        let results = resolve_tool_path_candidates(ResolveToolPathCandidatesInput {
            candidates: vec!["$PWD/../README.md".to_string()],
            cwd: Some("src".to_string()),
            project_root: root.to_string_lossy().to_string(),
        })
        .expect("resolve path candidates");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].raw_path, "$PWD/../README.md");
        assert!(!results[0].has_unexpanded_variables);
        assert_eq!(results[0].is_inside_project_root, Some(true));

        fs::remove_dir_all(root).expect("remove temporary root");
    }

    #[test]
    fn path_resolver_marks_unknown_variables_conservative() {
        let root = temporary_root("unknown-var");

        let results = resolve_tool_path_candidates(ResolveToolPathCandidatesInput {
            candidates: vec!["$WIZZLE_UNKNOWN_TEST_DIR/file.txt".to_string()],
            cwd: None,
            project_root: root.to_string_lossy().to_string(),
        })
        .expect("resolve path candidates");

        assert_eq!(results.len(), 1);
        assert!(results[0].has_unexpanded_variables);
        assert_eq!(results[0].is_inside_project_root, None);

        fs::remove_dir_all(root).expect("remove temporary root");
    }

    #[test]
    fn path_resolver_does_not_whitelist_unknown_variables_under_tmp() {
        let root = temporary_root("unknown-var-tmp");

        let results = resolve_tool_path_candidates(ResolveToolPathCandidatesInput {
            candidates: vec!["/tmp/$WIZZLE_UNKNOWN_TEST_DIR/file.txt".to_string()],
            cwd: None,
            project_root: root.to_string_lossy().to_string(),
        })
        .expect("resolve path candidates");

        assert_eq!(results.len(), 1);
        assert!(results[0].has_unexpanded_variables);
        assert!(!results[0].is_safe_external);
        assert_eq!(results[0].is_inside_project_root, None);

        fs::remove_dir_all(root).expect("remove temporary root");
    }

    #[test]
    fn path_resolver_marks_temp_paths_safe_external() {
        let root = temporary_root("tmp");

        let results = resolve_tool_path_candidates(ResolveToolPathCandidatesInput {
            candidates: vec!["/tmp/wizzle-safe-output.txt".to_string()],
            cwd: None,
            project_root: root.to_string_lossy().to_string(),
        })
        .expect("resolve path candidates");

        assert_eq!(results.len(), 1);
        assert!(results[0].is_safe_external);
        assert_eq!(results[0].is_inside_project_root, Some(false));

        fs::remove_dir_all(root).expect("remove temporary root");
    }

    #[cfg(unix)]
    #[test]
    fn path_resolver_does_not_whitelist_tmp_symlink_to_non_tmp_target() {
        use std::os::unix::fs::symlink;

        let root = temporary_root("tmp-symlink-root");
        let temp_link =
            std::env::temp_dir().join(format!("wizzle-resolve-link-{}", Uuid::new_v4()));
        symlink("/etc", &temp_link).expect("create temp symlink");

        let results = resolve_tool_path_candidates(ResolveToolPathCandidatesInput {
            candidates: vec![temp_link.to_string_lossy().to_string()],
            cwd: None,
            project_root: root.to_string_lossy().to_string(),
        })
        .expect("resolve path candidates");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].is_inside_project_root, Some(false));
        assert!(!results[0].is_safe_external);

        fs::remove_file(temp_link).expect("remove temp symlink");
        fs::remove_dir_all(root).expect("remove temporary root");
    }

    #[cfg(unix)]
    #[test]
    fn path_resolver_resolves_symlink_parent_for_missing_target() {
        use std::os::unix::fs::symlink;

        let root = temporary_root("symlink");
        let outside = temporary_root("outside");
        symlink(&outside, root.join("linked")).expect("create symlink");

        let results = resolve_tool_path_candidates(ResolveToolPathCandidatesInput {
            candidates: vec!["linked/new.txt".to_string()],
            cwd: None,
            project_root: root.to_string_lossy().to_string(),
        })
        .expect("resolve path candidates");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].is_inside_project_root, Some(false));
        assert!(results[0]
            .real_path
            .as_deref()
            .unwrap_or_default()
            .contains(outside.to_string_lossy().as_ref()));

        fs::remove_dir_all(root).expect("remove temporary root");
        fs::remove_dir_all(outside).expect("remove outside root");
    }
}
