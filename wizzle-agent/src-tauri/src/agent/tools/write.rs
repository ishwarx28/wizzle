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
struct WriteToolArguments {
    content: String,
    path: String,
}

pub fn resolve_lock_path(
    project_root: &std::path::Path,
    arguments: &Value,
    allow_external_paths: bool,
) -> Result<PathBuf, String> {
    let arguments: WriteToolArguments = serde_json::from_value(arguments.clone())
        .map_err(|error| format!("Invalid arguments for write: {error}"))?;
    pathing::resolve_target_tool_path_with_approval(
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
    let arguments: WriteToolArguments = serde_json::from_value(arguments)
        .map_err(|error| format!("Invalid arguments for write: {error}"))?;
    run_blocking("write", move || {
        execute(project_root, arguments, allow_external_paths)
    })
    .await
}

fn execute(
    project_root: PathBuf,
    arguments: WriteToolArguments,
    allow_external_paths: bool,
) -> Result<AgentToolRunPayload, String> {
    let path = pathing::resolve_target_tool_path_with_approval(
        &project_root,
        &arguments.path,
        allow_external_paths,
    )?;
    let created = !path.exists();
    if !created {
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        if metadata.len() > MAX_READ_SOURCE_BYTES as u64 {
            return Err(format!(
                "{} is larger than {} MB and cannot be safely replaced with the write tool.",
                path.display(),
                MAX_READ_SOURCE_BYTES / (1024 * 1024)
            ));
        }
    }
    let previous_content = fs::read_to_string(&path).ok();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not prepare {}: {error}", parent.display()))?;
    }
    fs::write(&path, arguments.content.as_bytes())
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    let before_content_hash =
        content_hash(previous_content.as_deref().unwrap_or_default().as_bytes());
    let (before_content, before_truncated) = truncate_text(
        previous_content.unwrap_or_default(),
        MAX_TOOL_FILE_CONTENT_BYTES,
    );
    let (after_content, after_truncated) =
        truncate_text(arguments.content.clone(), MAX_TOOL_FILE_CONTENT_BYTES);

    Ok(output::success(json!({
        "ok": true,
        "afterContent": after_content,
        "afterContentHash": content_hash(arguments.content.as_bytes()),
        "beforeContent": before_content,
        "beforeContentHash": before_content_hash,
        "bytesWritten": arguments.content.len(),
        "contentHash": content_hash(arguments.content.as_bytes()),
        "contentPath": path.to_string_lossy(),
        "created": created,
        "diffTruncated": before_truncated || after_truncated,
        "path": path.to_string_lossy(),
        "realPath": path.to_string_lossy(),
    })))
}
