use std::{fs, path::PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    output, pathing,
    shared::{
        content_hash, run_blocking, truncate_text, MAX_READ_SOURCE_BYTES,
        MAX_TOOL_FILE_CONTENT_BYTES,
    },
};
use crate::agent::types::AgentToolRunPayload;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditToolArguments {
    new_text: String,
    old_text: String,
    path: String,
    replace_all: Option<bool>,
}

pub fn resolve_lock_path(
    project_root: &std::path::Path,
    arguments: &Value,
    allow_external_paths: bool,
) -> Result<PathBuf, String> {
    let arguments: EditToolArguments = serde_json::from_value(arguments.clone())
        .map_err(|error| format!("Invalid arguments for edit: {error}"))?;
    pathing::resolve_existing_tool_path_with_approval(
        project_root,
        &arguments.path,
        allow_external_paths,
    )
}

pub async fn run(
    project_root: PathBuf,
    arguments: Value,
    allow_external_paths: bool,
) -> Result<AgentToolRunPayload, String> {
    let arguments: EditToolArguments = serde_json::from_value(arguments)
        .map_err(|error| format!("Invalid arguments for edit: {error}"))?;
    run_blocking("edit", move || {
        execute(project_root, arguments, allow_external_paths)
    })
    .await
}

fn execute(
    project_root: PathBuf,
    arguments: EditToolArguments,
    allow_external_paths: bool,
) -> Result<AgentToolRunPayload, String> {
    if arguments.old_text.is_empty() {
        return Err("The edit tool requires a non-empty oldText value.".to_string());
    }

    let path = pathing::resolve_existing_tool_path_with_approval(
        &project_root,
        &arguments.path,
        allow_external_paths,
    )?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    if metadata.len() > MAX_READ_SOURCE_BYTES as u64 {
        return Err(format!(
            "{} is larger than {} MB and cannot be safely edited.",
            path.display(),
            MAX_READ_SOURCE_BYTES / (1024 * 1024)
        ));
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let line_ending = if content.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let normalized_content = normalize_line_endings(&content);
    let normalized_old_text = normalize_line_endings(&arguments.old_text);
    let normalized_new_text = normalize_line_endings(&arguments.new_text);
    let occurrences = normalized_content.matches(&normalized_old_text).count();

    if occurrences == 0 {
        return Err(format!(
            "Could not find the requested text in {}.",
            path.display()
        ));
    }

    let normalized_updated_content = if arguments.replace_all.unwrap_or(false) {
        normalized_content.replace(&normalized_old_text, &normalized_new_text)
    } else {
        if occurrences > 1 {
            return Err(format!(
                "The requested text appears {occurrences} times in {}. Use replaceAll to make the edit explicit.",
                path.display()
            ));
        }

        normalized_content.replacen(&normalized_old_text, &normalized_new_text, 1)
    };
    let updated_content = if line_ending == "\r\n" {
        normalized_updated_content.replace('\n', "\r\n")
    } else {
        normalized_updated_content
    };

    fs::write(&path, updated_content.as_bytes())
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    let before_content_hash = content_hash(content.as_bytes());
    let after_content_hash = content_hash(updated_content.as_bytes());
    let (before_content, before_truncated) = truncate_text(content, MAX_TOOL_FILE_CONTENT_BYTES);
    let (after_content, after_truncated) =
        truncate_text(updated_content, MAX_TOOL_FILE_CONTENT_BYTES);

    Ok(output::success(json!({
        "afterContent": after_content,
        "afterContentHash": after_content_hash.clone(),
        "beforeContent": before_content,
        "beforeContentHash": before_content_hash,
        "contentHash": after_content_hash,
        "contentPath": path.to_string_lossy(),
        "created": false,
        "diffTruncated": before_truncated || after_truncated,
        "ok": true,
        "path": path.to_string_lossy(),
        "realPath": path.to_string_lossy(),
        "replacements": if arguments.replace_all.unwrap_or(false) { occurrences } else { 1 },
    })))
}

fn normalize_line_endings(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}
