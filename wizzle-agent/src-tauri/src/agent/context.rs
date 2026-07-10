use std::{
    fs::{self, File},
    io::Read,
    path::Path,
    process::Command,
};

use crate::workspace::{
    paths::{ensure_dir, ensure_workspace_storage, session_cache_dir},
    sqlite_repository,
};

use super::{
    tools::pathing,
    types::{AgentGlobalSkillFilePayload, AgentInstructionFilePayload, AgentProjectContextPayload},
};

const INSTRUCTION_FILE_NAMES: [&str; 1] = ["AGENTS.md"];
const MAX_DISCOVERY_ENTRIES: usize = 4_096;
const MAX_INSTRUCTION_DEPTH: usize = 16;
const MAX_SKILL_METADATA_BYTES: u64 = 16 * 1_024;
const SKIPPED_INSTRUCTION_DIRS: [&str; 7] = [
    ".git",
    ".next",
    "build",
    "dist",
    "node_modules",
    "target",
    "vendor",
];

fn find_instruction_file(path: &Path) -> Option<AgentInstructionFilePayload> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
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

fn run_git(project_root: &Path, args: &[&str]) -> Option<String> {
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

fn resolve_git_tracked_state(project_root: &Path) -> String {
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

fn has_markdown_extension(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()).map(|value| value.to_ascii_lowercase()),
        Some(extension) if matches!(extension.as_str(), "md" | "mdx" | "markdown")
    )
}

fn should_skip_instruction_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| SKIPPED_INSTRUCTION_DIRS.contains(&name))
}

fn collect_nested_instruction_files(
    directory: &Path,
    depth: usize,
    inspected_entries: &mut usize,
    files: &mut Vec<AgentInstructionFilePayload>,
) {
    if depth > MAX_INSTRUCTION_DEPTH || *inspected_entries >= MAX_DISCOVERY_ENTRIES {
        return;
    }

    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    paths.sort();

    for path in paths {
        *inspected_entries += 1;
        if *inspected_entries > MAX_DISCOVERY_ENTRIES {
            return;
        }

        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_file()
            && path.file_name().and_then(|value| value.to_str()) == Some("AGENTS.md")
        {
            if let Some(file) = find_instruction_file(&path) {
                files.push(file);
            }
        } else if metadata.is_dir() && !should_skip_instruction_dir(&path) {
            collect_nested_instruction_files(&path, depth + 1, inspected_entries, files);
        }
    }
}

fn discover_instruction_files(project_root: &Path) -> Vec<AgentInstructionFilePayload> {
    let mut files = Vec::new();

    for ancestor in project_root
        .ancestors()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        for file_name in INSTRUCTION_FILE_NAMES {
            if let Some(file) = find_instruction_file(&ancestor.join(file_name)) {
                files.push(file);
            }
        }
    }

    let mut inspected_entries = 0;
    collect_nested_instruction_files(project_root, 0, &mut inspected_entries, &mut files);
    files.sort_by(|left, right| {
        let left_depth = Path::new(&left.path).components().count();
        let right_depth = Path::new(&right.path).components().count();
        left_depth
            .cmp(&right_depth)
            .then_with(|| left.path.cmp(&right.path))
    });
    files.dedup_by(|left, right| left.path == right.path);
    files
}

fn skill_description(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?.take(MAX_SKILL_METADATA_BYTES);
    let mut content = String::new();
    file.read_to_string(&mut content).ok()?;

    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(description) = trimmed.strip_prefix("description:") {
            let description = description.trim().trim_matches(['\'', '"']);
            if !description.is_empty() {
                return Some(description.to_string());
            }
        }
    }

    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#') && *line != "---")
        .map(ToString::to_string)
}

fn skill_payload(path: &Path, name: String) -> Option<AgentGlobalSkillFilePayload> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || !has_markdown_extension(path) {
        return None;
    }

    Some(AgentGlobalSkillFilePayload {
        description: skill_description(path),
        name,
        path: path.to_string_lossy().to_string(),
    })
}

fn discover_global_skill_files(
    global_skills_dir: &Path,
) -> Result<Vec<AgentGlobalSkillFilePayload>, String> {
    let entries = fs::read_dir(global_skills_dir).map_err(|error| {
        format!(
            "Could not inspect the global skills directory {}: {error}",
            global_skills_dir.display()
        )
    })?;
    let mut skill_files = Vec::new();

    for entry in entries.take(MAX_DISCOVERY_ENTRIES).filter_map(Result::ok) {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }

        if metadata.is_file() {
            if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
                if let Some(payload) = skill_payload(&path, name.to_string()) {
                    skill_files.push(payload);
                }
            }
            continue;
        }

        if metadata.is_dir() {
            let manifest = path.join("SKILL.md");
            if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
                if let Some(payload) = skill_payload(&manifest, name.to_string()) {
                    skill_files.push(payload);
                }
            }
        }
    }

    skill_files.sort_by_key(|skill| skill.name.to_lowercase());
    Ok(skill_files)
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

    let skill_files = discover_global_skill_files(&global_skills_dir)?;

    Ok((Some(display_path), skill_files))
}

pub fn load_agent_project_context(
    project_id: String,
    session_id: Option<String>,
) -> Result<AgentProjectContextPayload, String> {
    let project_root = sqlite_repository::resolve_project_root(&project_id)?;
    let (global_skills_dir, global_skill_files) = load_global_skill_inventory()?;
    let git_tracked_state = resolve_git_tracked_state(&project_root);
    let session_cache_dir = resolve_session_cache_dir(session_id)?;
    let instruction_files = discover_instruction_files(&project_root);

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

#[cfg(test)]
mod tests {
    use super::{discover_global_skill_files, discover_instruction_files};
    use std::fs;

    fn temporary_dir(label: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("wizzle-context-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create test directory");
        path
    }

    #[test]
    fn discovers_ancestor_and_nested_instruction_scopes() {
        let workspace = temporary_dir("instructions");
        let project = workspace.join("packages/app");
        let nested = project.join("src/feature");
        fs::create_dir_all(&nested).expect("create nested project");
        fs::write(workspace.join("AGENTS.md"), "workspace").expect("write workspace instructions");
        fs::write(project.join("AGENTS.md"), "project").expect("write project instructions");
        fs::write(nested.join("AGENTS.md"), "feature").expect("write nested instructions");
        fs::create_dir_all(project.join("node_modules/pkg")).expect("create skipped tree");
        fs::write(project.join("node_modules/pkg/AGENTS.md"), "ignored")
            .expect("write ignored instructions");

        let paths = discover_instruction_files(&project)
            .into_iter()
            .map(|file| file.path)
            .collect::<Vec<_>>();

        assert!(paths.contains(&workspace.join("AGENTS.md").to_string_lossy().to_string()));
        assert!(paths.contains(&project.join("AGENTS.md").to_string_lossy().to_string()));
        assert!(paths.contains(&nested.join("AGENTS.md").to_string_lossy().to_string()));
        assert!(!paths.iter().any(|path| path.contains("node_modules")));
        fs::remove_dir_all(workspace).expect("remove test directory");
    }

    #[test]
    fn discovers_flat_and_directory_skills_with_descriptions() {
        let root = temporary_dir("skills");
        fs::write(root.join("flat.md"), "# Flat\n\nFlat skill.").expect("write flat skill");
        fs::create_dir_all(root.join("reviewer")).expect("create skill directory");
        fs::write(
            root.join("reviewer/SKILL.md"),
            "---\ndescription: Review code safely\n---\n# Reviewer",
        )
        .expect("write skill manifest");
        fs::create_dir_all(root.join("ignored/nested")).expect("create nested directory");
        fs::write(root.join("ignored/nested/SKILL.md"), "ignored").expect("write nested manifest");

        let skills = discover_global_skill_files(&root).expect("discover skills");
        assert_eq!(skills.len(), 2);
        assert!(skills.iter().any(|skill| skill.name == "flat.md"));
        let reviewer = skills
            .iter()
            .find(|skill| skill.name == "reviewer")
            .expect("reviewer skill");
        assert_eq!(reviewer.description.as_deref(), Some("Review code safely"));
        fs::remove_dir_all(root).expect("remove test directory");
    }
}
