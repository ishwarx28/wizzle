use std::{fs, path::PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    output, pathing,
    shared::{content_hash, run_blocking_with_timeout, truncate_text, ToolTimeout, MAX_READ_BYTES},
};
use crate::agent::types::AgentToolRunPayload;
use crate::image_preview::build_inline_image_payload;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadToolArguments {
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
    timeout: Option<ToolTimeout>,
}

pub async fn run(project_root: PathBuf, arguments: Value) -> Result<AgentToolRunPayload, String> {
    let arguments: ReadToolArguments = serde_json::from_value(arguments)
        .map_err(|error| format!("Invalid arguments for read: {error}"))?;
    let timeout = arguments.timeout.unwrap_or_default();

    run_blocking_with_timeout(timeout, "read", move || {
        execute(project_root, arguments, timeout)
    })
    .await
}

fn execute(
    project_root: PathBuf,
    arguments: ReadToolArguments,
    timeout: ToolTimeout,
) -> Result<AgentToolRunPayload, String> {
    let path = pathing::resolve_existing_read_path(&project_root, &arguments.path)?;
    let bytes =
        fs::read(&path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;

    if let Some(image) = build_inline_image_payload(&path.to_string_lossy(), &bytes)? {
        return Ok(output::success(json!({
            "ok": true,
            "contentHash": content_hash(&bytes),
            "contentPath": path.to_string_lossy(),
            "path": path.to_string_lossy(),
            "realPath": path.to_string_lossy(),
            "timeout": timeout.label(),
            "binary": true,
            "mimeType": image.mime_type,
            "imageSrc": image.image_src,
            "bytes": bytes.len(),
            "content": Value::Null,
        })));
    }

    let content = match String::from_utf8(bytes.clone()) {
        Ok(content) => content,
        Err(_) => {
            return Ok(output::success(json!({
                "ok": true,
                "contentHash": content_hash(&bytes),
                "contentPath": path.to_string_lossy(),
                "path": path.to_string_lossy(),
                "realPath": path.to_string_lossy(),
                "timeout": timeout.label(),
                "binary": true,
                "bytes": bytes.len(),
                "content": Value::Null,
                "message": format!("{} is a binary file and cannot be displayed as text.", path.display()),
            })));
        }
    };

    let all_lines = content.lines().collect::<Vec<_>>();
    let total_lines = all_lines.len();
    let start_line = arguments.start_line.unwrap_or(1).max(1);
    let end_line = arguments
        .end_line
        .unwrap_or(total_lines.max(1))
        .max(start_line);
    let selected_lines = all_lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            let line_number = index + 1;
            (line_number >= start_line && line_number <= end_line).then_some(*line)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let fallback_content = if total_lines == 0 {
        String::new()
    } else {
        selected_lines
    };
    let (truncated_content, was_truncated) = truncate_text(fallback_content, MAX_READ_BYTES);

    Ok(output::success(json!({
        "ok": true,
        "contentHash": content_hash(truncated_content.as_bytes()),
        "contentPath": path.to_string_lossy(),
        "path": path.to_string_lossy(),
        "realPath": path.to_string_lossy(),
        "startLine": start_line,
        "endLine": end_line.min(total_lines.max(start_line)),
        "timeout": timeout.label(),
        "totalLines": total_lines,
        "truncated": was_truncated,
        "content": truncated_content,
    })))
}
