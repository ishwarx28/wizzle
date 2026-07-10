use std::{
    fs::{self, File},
    io::{Read, Take},
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    output, pathing,
    shared::{content_hash, run_blocking, truncate_text, MAX_READ_BYTES, MAX_READ_SOURCE_BYTES},
};
use crate::agent::types::AgentToolRunPayload;
use crate::image_preview::{
    build_inline_image_payload, file_extension, is_supported_image_extension,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadToolArguments {
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
}

pub async fn run(
    project_root: PathBuf,
    arguments: Value,
    image_capable: bool,
) -> Result<AgentToolRunPayload, String> {
    let arguments: ReadToolArguments = serde_json::from_value(arguments)
        .map_err(|error| format!("Invalid arguments for read: {error}"))?;
    run_blocking("read", move || {
        execute(project_root, arguments, image_capable)
    })
    .await
}

fn execute(
    project_root: PathBuf,
    arguments: ReadToolArguments,
    image_capable: bool,
) -> Result<AgentToolRunPayload, String> {
    let path = pathing::resolve_existing_read_path(&project_root, &arguments.path)?;
    let is_image = is_supported_image_extension(&file_extension(&path.to_string_lossy()));
    if is_image && !image_capable {
        return Ok(output::error(
            "This model does not support images. Image files cannot be read with the current model."
                .to_string(),
        ));
    }
    let bytes = read_bounded_file(&path)?;

    if let Some(image) = build_inline_image_payload(&path.to_string_lossy(), &bytes)? {
        return Ok(output::success(json!({
            "ok": true,
            "contentHash": content_hash(&bytes),
            "contentPath": path.to_string_lossy(),
            "path": path.to_string_lossy(),
            "realPath": path.to_string_lossy(),
            "binary": true,
            "mimeType": image.mime_type,
            "imageSrc": image.image_src,
            "bytes": bytes.len(),
            "content": Value::Null,
        })));
    }

    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(error) => {
            let bytes = error.into_bytes();
            return Ok(output::success(json!({
                "ok": true,
                "contentHash": content_hash(&bytes),
                "contentPath": path.to_string_lossy(),
                "path": path.to_string_lossy(),
                "realPath": path.to_string_lossy(),
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
        "totalLines": total_lines,
        "truncated": was_truncated,
        "content": truncated_content,
    })))
}

fn read_bounded_file(path: &Path) -> Result<Vec<u8>, String> {
    read_bounded_file_with_limit(path, MAX_READ_SOURCE_BYTES)
}

fn read_bounded_file_with_limit(path: &Path, max_bytes: usize) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file.", path.display()));
    }
    if metadata.len() > max_bytes as u64 {
        return Err(read_size_error(path, max_bytes));
    }

    let file =
        File::open(path).map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let mut reader: Take<File> = file.take(max_bytes as u64 + 1);
    let mut bytes = Vec::with_capacity((metadata.len() as usize).min(max_bytes));
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;

    if bytes.len() > max_bytes {
        return Err(read_size_error(path, max_bytes));
    }

    Ok(bytes)
}

fn read_size_error(path: &Path, max_bytes: usize) -> String {
    let kind = if is_supported_image_extension(&file_extension(&path.to_string_lossy())) {
        "image"
    } else {
        "file"
    };
    format!(
        "The {kind} {} is larger than {} MB and cannot be read safely.",
        path.display(),
        max_bytes / (1024 * 1024)
    )
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::read_bounded_file_with_limit;

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("wizzle-read-{name}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn bounded_read_rejects_large_files_before_loading_them() {
        let path = test_path("large");
        let file = fs::File::create(&path).expect("create test file");
        file.set_len(1_000_000).expect("size sparse test file");

        let error = read_bounded_file_with_limit(&path, 16).expect_err("file must be rejected");
        assert!(error.contains("cannot be read safely"));

        fs::remove_file(path).expect("remove test file");
    }

    #[test]
    fn bounded_read_accepts_content_at_the_limit() {
        let path = test_path("exact");
        fs::write(&path, b"1234567890abcdef").expect("write test file");

        let bytes = read_bounded_file_with_limit(&path, 16).expect("read bounded file");
        assert_eq!(bytes, b"1234567890abcdef");

        fs::remove_file(path).expect("remove test file");
    }
}
