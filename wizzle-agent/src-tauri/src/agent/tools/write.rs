use std::{fs, path::PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    output, pathing,
    shared::{
        content_hash, run_blocking_with_timeout, truncate_text, ToolTimeout,
        MAX_TOOL_FILE_CONTENT_BYTES,
    },
};
use crate::agent::types::AgentToolRunPayload;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteToolArguments {
    content: String,
    path: String,
    timeout: Option<ToolTimeout>,
}

pub fn resolve_lock_path(
    project_root: &std::path::Path,
    arguments: &Value,
) -> Result<PathBuf, String> {
    let arguments: WriteToolArguments = serde_json::from_value(arguments.clone())
        .map_err(|error| format!("Invalid arguments for write: {error}"))?;
    pathing::resolve_target_tool_path(project_root, &arguments.path)
}

pub async fn run(project_root: PathBuf, arguments: Value) -> Result<AgentToolRunPayload, String> {
    let arguments: WriteToolArguments = serde_json::from_value(arguments)
        .map_err(|error| format!("Invalid arguments for write: {error}"))?;
    let timeout = arguments.timeout.unwrap_or_default();

    run_blocking_with_timeout(timeout, "write", move || {
        execute(project_root, arguments, timeout)
    })
    .await
}

fn execute(
    project_root: PathBuf,
    arguments: WriteToolArguments,
    timeout: ToolTimeout,
) -> Result<AgentToolRunPayload, String> {
    let path = pathing::resolve_target_tool_path(&project_root, &arguments.path)?;
    let created = !path.exists();
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
        "timeout": timeout.label(),
    })))
}
