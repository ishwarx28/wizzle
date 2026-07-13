use std::{
    env, fs,
    path::{Component, Path, PathBuf},
};

use crate::workspace::sqlite_repository;

pub fn canonical_project_root(project_id: &str) -> Result<PathBuf, String> {
    let root = sqlite_repository::resolve_project_root(project_id)?;
    fs::canonicalize(&root).map_err(|error| {
        format!(
            "Could not resolve the project root {}: {error}",
            root.display()
        )
    })
}

fn path_stays_inside_root(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
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

pub fn global_skills_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".wizzle").join("skills"))
}

fn expand_home_path(requested_path: &str) -> PathBuf {
    if requested_path == "~"
        || requested_path.starts_with("~/")
        || requested_path.starts_with("~\\")
    {
        if let Some(home_dir) = home_dir() {
            if requested_path == "~" {
                return home_dir;
            }

            return home_dir.join(&requested_path[2..]);
        }
    }

    PathBuf::from(requested_path)
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

fn normalize_candidate_path(
    project_root: &Path,
    requested_path: &str,
    enforce_root_boundary: bool,
) -> Result<PathBuf, String> {
    if requested_path.trim().is_empty() {
        return Err("The path cannot be empty.".to_string());
    }

    let raw_path = expand_home_path(requested_path);
    let candidate = if raw_path.is_absolute() {
        raw_path
    } else {
        project_root.join(raw_path)
    };

    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && enforce_root_boundary {
                    return Err("The requested path is outside the selected project.".to_string());
                }
            }
            Component::Normal(value) => normalized.push(value),
        }
    }

    if enforce_root_boundary && !path_stays_inside_root(project_root, &normalized) {
        return Err("The requested path is outside the selected project.".to_string());
    }

    Ok(normalized)
}

fn ensure_existing_path_prefix_has_no_symlinks(
    project_root: &Path,
    candidate: &Path,
) -> Result<(), String> {
    let relative_path = candidate
        .strip_prefix(project_root)
        .map_err(|_| "The requested path is outside the selected project.".to_string())?;
    let mut current = project_root.to_path_buf();

    for component in relative_path.components() {
        current.push(component.as_os_str());

        if !current.exists() {
            break;
        }

        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("Could not inspect {}: {error}", current.display()))?;

        if metadata.file_type().is_symlink() {
            return Err(format!(
                "The requested path traverses a symlink at {}. Symlink paths are not allowed.",
                current.display()
            ));
        }
    }

    Ok(())
}

fn validate_path_reference_with_boundary(
    project_root: &Path,
    requested_path: &str,
    enforce_root_boundary: bool,
) -> Result<PathBuf, String> {
    let candidate = normalize_candidate_path(project_root, requested_path, enforce_root_boundary)?;

    if !enforce_root_boundary {
        return Ok(candidate);
    }

    ensure_existing_path_prefix_has_no_symlinks(project_root, &candidate)?;
    Ok(candidate)
}

fn resolve_existing_path_with_boundary(
    project_root: &Path,
    requested_path: &str,
    enforce_root_boundary: bool,
) -> Result<PathBuf, String> {
    let candidate =
        validate_path_reference_with_boundary(project_root, requested_path, enforce_root_boundary)?;
    let canonical_candidate = fs::canonicalize(&candidate)
        .map_err(|error| format!("Could not read {}: {error}", candidate.display()))?;

    if enforce_root_boundary && !path_stays_inside_root(project_root, &canonical_candidate) {
        return Err("The requested path is outside the selected project.".to_string());
    }

    Ok(canonical_candidate)
}

pub fn resolve_existing_path_with_approval(
    project_root: &Path,
    requested_path: &str,
    allow_external_paths: bool,
) -> Result<PathBuf, String> {
    resolve_existing_path_with_boundary(project_root, requested_path, !allow_external_paths)
}

pub fn resolve_existing_path(project_root: &Path, requested_path: &str) -> Result<PathBuf, String> {
    resolve_existing_path_with_approval(project_root, requested_path, false)
}

pub fn resolve_existing_read_path_with_approval(
    project_root: &Path,
    requested_path: &str,
    allow_external_paths: bool,
) -> Result<PathBuf, String> {
    if allow_external_paths {
        return resolve_existing_path_with_boundary(project_root, requested_path, false);
    }

    let candidate = normalize_candidate_path(project_root, requested_path, false)?;

    if path_stays_inside_root(project_root, &candidate) {
        return resolve_existing_path_with_boundary(project_root, requested_path, true);
    }

    if candidate.file_name().and_then(|value| value.to_str()) == Some("AGENTS.md") {
        let candidate_parent = candidate.parent().ok_or_else(|| {
            "Could not determine the parent directory for the instruction file.".to_string()
        })?;
        let normalized_project_root = normalize_path(project_root);
        let normalized_parent = normalize_path(candidate_parent);

        if path_stays_inside_root(&normalized_parent, &normalized_project_root) {
            let metadata = fs::symlink_metadata(&candidate)
                .map_err(|error| format!("Could not read {}: {error}", candidate.display()))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(
                    "Project instruction files must be regular files, not symlinks.".to_string(),
                );
            }
            return fs::canonicalize(&candidate)
                .map_err(|error| format!("Could not read {}: {error}", candidate.display()));
        }
    }

    let Some(global_skills_dir) = global_skills_dir() else {
        return Err(
            "The requested path is outside the selected project and ~/.wizzle/skills/.".to_string(),
        );
    };
    let normalized_skills_dir = normalize_path(&global_skills_dir);
    let normalized_candidate = normalize_path(&candidate);

    if !path_stays_inside_root(&normalized_skills_dir, &normalized_candidate) {
        return Err(
            "The requested path is outside the selected project and ~/.wizzle/skills/.".to_string(),
        );
    }

    let canonical_candidate = fs::canonicalize(&candidate)
        .map_err(|error| format!("Could not read {}: {error}", candidate.display()))?;
    let canonical_skills_dir =
        fs::canonicalize(&global_skills_dir).unwrap_or(normalized_skills_dir);

    if !path_stays_inside_root(&canonical_skills_dir, &canonical_candidate) {
        return Err(
            "The requested path is outside the selected project and ~/.wizzle/skills/.".to_string(),
        );
    }

    Ok(canonical_candidate)
}

pub fn resolve_existing_tool_path_with_approval(
    project_root: &Path,
    requested_path: &str,
    allow_external_paths: bool,
) -> Result<PathBuf, String> {
    resolve_existing_path_with_boundary(project_root, requested_path, !allow_external_paths)
}

fn resolve_target_path_with_boundary(
    project_root: &Path,
    requested_path: &str,
    enforce_root_boundary: bool,
) -> Result<PathBuf, String> {
    let candidate =
        validate_path_reference_with_boundary(project_root, requested_path, enforce_root_boundary)?;

    if candidate.exists() {
        return resolve_existing_path_with_boundary(
            project_root,
            requested_path,
            enforce_root_boundary,
        );
    }

    let parent = candidate.parent().ok_or_else(|| {
        format!(
            "Could not determine the parent directory for {}.",
            candidate.display()
        )
    })?;
    if !parent.exists() {
        return Err(format!(
            "Could not access the parent directory {} because it does not exist.",
            parent.display()
        ));
    }

    let file_name = candidate.file_name().ok_or_else(|| {
        format!(
            "Could not determine the file name for {}.",
            candidate.display()
        )
    })?;

    Ok(parent.join(file_name))
}

pub fn resolve_target_tool_path_with_approval(
    project_root: &Path,
    requested_path: &str,
    allow_external_paths: bool,
) -> Result<PathBuf, String> {
    resolve_target_path_with_boundary(project_root, requested_path, !allow_external_paths)
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_existing_read_path_with_approval, resolve_existing_tool_path_with_approval,
        resolve_target_tool_path_with_approval,
    };
    use std::fs;
    use uuid::Uuid;

    fn temporary_root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("wizzle-pathing-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temporary project root");
        fs::canonicalize(root).expect("canonicalize temporary project root")
    }

    #[test]
    fn mutation_paths_reject_parent_traversal() {
        let root = temporary_root();
        fs::write(root.join("inside.txt"), "inside").expect("write fixture");

        assert!(resolve_existing_tool_path_with_approval(&root, "../outside.txt", false).is_err());
        assert!(resolve_target_tool_path_with_approval(&root, "../outside.txt", false).is_err());

        fs::remove_dir_all(root).expect("remove temporary project root");
    }

    #[test]
    fn approved_paths_can_escape_project_root() {
        let root = temporary_root();
        let outside = std::env::temp_dir().join(format!("wizzle-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(&outside).expect("create outside directory");
        let read_path = outside.join("read.txt");
        let edit_path = outside.join("edit.txt");
        let write_path = outside.join("write.txt");
        fs::write(&read_path, "read").expect("write read fixture");
        fs::write(&edit_path, "edit").expect("write edit fixture");

        assert_eq!(
            resolve_existing_read_path_with_approval(&root, &read_path.to_string_lossy(), true,)
                .expect("approved read should resolve"),
            fs::canonicalize(&read_path).expect("canonical read path"),
        );
        assert_eq!(
            resolve_existing_tool_path_with_approval(&root, &edit_path.to_string_lossy(), true,)
                .expect("approved edit should resolve"),
            fs::canonicalize(&edit_path).expect("canonical edit path"),
        );
        assert_eq!(
            resolve_target_tool_path_with_approval(&root, &write_path.to_string_lossy(), true,)
                .expect("approved write should resolve"),
            write_path,
        );

        fs::remove_dir_all(root).expect("remove temporary project root");
        fs::remove_dir_all(outside).expect("remove outside directory");
    }

    #[test]
    fn reads_only_named_instruction_files_from_project_ancestors() {
        let parent = temporary_root();
        let project_root = parent.join("nested/project");
        fs::create_dir_all(&project_root).expect("create nested project");
        let instruction_path = parent.join("AGENTS.md");
        let unrelated_path = parent.join("secrets.txt");
        fs::write(&instruction_path, "instructions").expect("write instruction file");
        fs::write(&unrelated_path, "secret").expect("write unrelated file");

        assert_eq!(
            resolve_existing_read_path_with_approval(
                &project_root,
                &instruction_path.to_string_lossy(),
                false,
            )
            .expect("ancestor instruction should be readable"),
            fs::canonicalize(&instruction_path).expect("canonical instruction path"),
        );
        assert!(resolve_existing_read_path_with_approval(
            &project_root,
            &unrelated_path.to_string_lossy(),
            false,
        )
        .is_err());

        fs::remove_dir_all(parent).expect("remove temporary root");
    }

    #[cfg(unix)]
    #[test]
    fn mutation_paths_reject_symlink_parents() {
        use std::os::unix::fs::symlink;

        let root = temporary_root();
        let outside = std::env::temp_dir().join(format!("wizzle-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(&outside).expect("create outside directory");
        symlink(&outside, root.join("linked")).expect("create symlink");

        assert!(resolve_target_tool_path_with_approval(&root, "linked/new.txt", false).is_err());

        fs::remove_dir_all(root).expect("remove temporary project root");
        fs::remove_dir_all(outside).expect("remove outside directory");
    }
}
