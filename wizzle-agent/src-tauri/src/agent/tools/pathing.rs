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
                if !normalized.pop() {
                    if enforce_root_boundary {
                        return Err(
                            "The requested path is outside the selected project.".to_string()
                        );
                    }
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

pub fn resolve_existing_path(project_root: &Path, requested_path: &str) -> Result<PathBuf, String> {
    resolve_existing_path_with_boundary(project_root, requested_path, true)
}

pub fn resolve_existing_read_path(
    project_root: &Path,
    requested_path: &str,
) -> Result<PathBuf, String> {
    let candidate = normalize_candidate_path(project_root, requested_path, false)?;

    if path_stays_inside_root(project_root, &candidate) {
        return resolve_existing_path_with_boundary(project_root, requested_path, true);
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

pub fn resolve_existing_tool_path(
    project_root: &Path,
    requested_path: &str,
) -> Result<PathBuf, String> {
    resolve_existing_path_with_boundary(project_root, requested_path, false)
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

pub fn resolve_target_tool_path(
    project_root: &Path,
    requested_path: &str,
) -> Result<PathBuf, String> {
    resolve_target_path_with_boundary(project_root, requested_path, false)
}
