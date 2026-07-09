use std::{fs, path::PathBuf, process::Command};

use crate::workspace::{
    paths::{ensure_dir, ensure_workspace_storage, session_cache_dir},
    sqlite_repository,
};

use super::{
    tools::pathing,
    types::{AgentGlobalSkillFilePayload, AgentInstructionFilePayload, AgentProjectContextPayload},
};

const INSTRUCTION_FILE_NAMES: [&str; 1] = ["AGENTS.md"];

fn find_instruction_file(path: PathBuf) -> Option<AgentInstructionFilePayload> {
    if !path.is_file() {
        return None;
    }

    let name = path.file_name().and_then(|value| value.to_str())?;

    Some(AgentInstructionFilePayload {
        name: name.to_string(),
        path: path.to_string_lossy().to_string(),
    })
}

fn resolve_session_cache_dir(session_id: Option<String>) -> Result<Option<String>, String> {
    let Some(session_id) = session_id else {
        return Ok(None);
    };

    let root = ensure_workspace_storage()?;
    let cache_dir = session_cache_dir(&root, &session_id)?;
    ensure_dir(&cache_dir)?;

    Ok(Some(cache_dir.to_string_lossy().to_string()))
}

fn run_git(project_root: &PathBuf, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(project_root)
        .args(args)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn resolve_git_tracked_state(project_root: &PathBuf) -> String {
    match run_git(project_root, &["rev-parse", "--is-inside-work-tree"]) {
        Some(value) if value == "true" => {}
        Some(_) => return "Not a Git worktree.".to_string(),
        None => return "Git status unavailable.".to_string(),
    }

    let Some(status) = run_git(project_root, &["status", "--short", "--untracked-files=no"]) else {
        return "Git worktree; tracked status unavailable.".to_string();
    };
    let tracked_change_count = status
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();

    if tracked_change_count == 0 {
        "Git worktree with no tracked file changes.".to_string()
    } else {
        format!("Git worktree with {tracked_change_count} tracked file change(s).")
    }
}

fn has_markdown_extension(path: &PathBuf) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()).map(|value| value.to_ascii_lowercase()),
        Some(extension) if matches!(extension.as_str(), "md" | "mdx" | "markdown")
    )
}

fn load_global_skill_inventory(
) -> Result<(Option<String>, Vec<AgentGlobalSkillFilePayload>), String> {
    let Some(global_skills_dir) = pathing::global_skills_dir() else {
        return Ok((None, Vec::new()));
    };
    let display_path = global_skills_dir.to_string_lossy().to_string();

    if !global_skills_dir.exists() {
        return Ok((Some(display_path), Vec::new()));
    }

    let entries = fs::read_dir(&global_skills_dir).map_err(|error| {
        format!(
            "Could not inspect the global skills directory {}: {error}",
            global_skills_dir.display()
        )
    })?;
    let mut skill_files = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.is_file() && has_markdown_extension(path))
        .filter_map(|path| {
            let name = path.file_name()?.to_str()?.to_string();
            Some(AgentGlobalSkillFilePayload {
                name,
                path: path.to_string_lossy().to_string(),
            })
        })
        .collect::<Vec<_>>();

    skill_files.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    Ok((Some(display_path), skill_files))
}

pub fn load_agent_project_context(
    project_id: String,
    session_id: Option<String>,
) -> Result<AgentProjectContextPayload, String> {
    let project_root = sqlite_repository::resolve_project_root(&project_id)?;
    let mut instruction_files = Vec::new();
    let (global_skills_dir, global_skill_files) = load_global_skill_inventory()?;
    let git_tracked_state = resolve_git_tracked_state(&project_root);
    let session_cache_dir = resolve_session_cache_dir(session_id)?;

    for file_name in INSTRUCTION_FILE_NAMES {
        if let Some(instruction_file) = find_instruction_file(project_root.join(file_name)) {
            instruction_files.push(instruction_file);
        }
    }

    Ok(AgentProjectContextPayload {
        git_tracked_state,
        global_skill_files,
        global_skills_dir,
        instruction_files,
        project_id,
        project_root: project_root.to_string_lossy().to_string(),
        session_cache_dir,
    })
}
