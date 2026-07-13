use std::{
    fs::{self, File},
    io::{Read, Take},
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    output, pathing,
    shared::{
        content_hash, run_blocking, MAX_LINE_LENGTH, MAX_READ_BYTES, MAX_READ_LINES,
        MAX_READ_SOURCE_BYTES,
    },
};
use crate::agent::types::AgentToolRunPayload;
use crate::image_preview::{
    build_inline_image_payload, file_extension, is_supported_image_extension,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadToolArguments {
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
}

pub async fn run(
    project_root: PathBuf,
    arguments: Value,
    image_capable: bool,
    allow_external_paths: bool,
) -> Result<AgentToolRunPayload, String> {
    let arguments: ReadToolArguments = serde_json::from_value(arguments)
        .map_err(|error| format!("Invalid arguments for read: {error}"))?;
    run_blocking("read", move || {
        execute(project_root, arguments, image_capable, allow_external_paths)
    })
    .await
}

fn execute(
    project_root: PathBuf,
    arguments: ReadToolArguments,
    image_capable: bool,
    allow_external_paths: bool,
) -> Result<AgentToolRunPayload, String> {
    let path = pathing::resolve_existing_read_path_with_approval(
        &project_root,
        &arguments.path,
        allow_external_paths,
    )?;
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

    let content = match std::str::from_utf8(&bytes) {
        Ok(content) => content.to_string(),
        Err(_) => {
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

    let paging_requested = arguments.offset.is_some() || arguments.limit.is_some();

    if bytes.len() <= MAX_READ_BYTES && !paging_requested {
        return Ok(output::success(json!({
            "ok": true,
            "contentHash": content_hash(content.as_bytes()),
            "contentPath": path.to_string_lossy(),
            "path": path.to_string_lossy(),
            "realPath": path.to_string_lossy(),
            "content": content,
        })));
    }

    let offset = arguments.offset.unwrap_or(1).max(1);
    let limit = arguments
        .limit
        .unwrap_or(MAX_READ_LINES)
        .clamp(1, MAX_READ_LINES);
    let page = build_text_page(&content, offset, limit);
    let mime = infer_text_mime(&path);

    let mut payload = json!({
        "ok": true,
        "type": "text-page",
        "contentHash": content_hash(bytes.as_slice()),
        "contentPath": path.to_string_lossy(),
        "path": path.to_string_lossy(),
        "realPath": path.to_string_lossy(),
        "content": page.content,
        "mime": mime,
        "offset": offset,
        "truncated": page.truncated,
    });

    if let (Value::Object(ref mut object), Some(next)) = (&mut payload, page.next) {
        object.insert("next".to_string(), json!(next));
    }

    Ok(output::success(payload))
}

struct TextPage {
    content: String,
    next: Option<usize>,
    truncated: bool,
}

fn build_text_page(content: &str, offset: usize, limit: usize) -> TextPage {
    let page_start = offset.saturating_sub(1);
    let all_lines = content.lines().collect::<Vec<_>>();
    let page_lines = all_lines
        .iter()
        .skip(page_start)
        .take(limit)
        .map(|line| truncate_line(line))
        .collect::<Vec<_>>();
    let returned_lines = page_lines.len();
    let next = offset.saturating_add(returned_lines);
    let truncated = page_start < all_lines.len() && next.saturating_sub(1) < all_lines.len();

    TextPage {
        content: page_lines.join("\n"),
        next: truncated.then_some(next),
        truncated,
    }
}

fn truncate_line(line: &str) -> String {
    if line.chars().count() <= MAX_LINE_LENGTH {
        return line.to_string();
    }

    let truncated = line.chars().take(MAX_LINE_LENGTH).collect::<String>();
    format!("{truncated}... (line truncated to 2000 chars)")
}

fn infer_text_mime(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);

    match extension.as_deref() {
        Some("csv") => "text/csv",
        Some("html") | Some("htm") => "text/html",
        Some("ipynb") | Some("json") => "application/json",
        Some("js") | Some("jsx") | Some("ts") | Some("tsx") => "text/javascript",
        Some("md") | Some("mdx") | Some("markdown") => "text/markdown",
        Some("toml") => "application/toml",
        Some("xml") => "application/xml",
        Some("yaml") | Some("yml") => "application/yaml",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        _ => "text/plain",
    }
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

    use serde_json::Value;

    use super::{execute, read_bounded_file_with_limit, ReadToolArguments};

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("wizzle-read-{name}-{}", uuid::Uuid::new_v4()))
    }

    fn test_root(name: &str) -> PathBuf {
        let root = test_path(name);
        fs::create_dir_all(&root).expect("create test root");
        fs::canonicalize(root).expect("canonicalize test root")
    }

    fn parse_output(output: Option<String>) -> Value {
        serde_json::from_str(&output.expect("tool output")).expect("valid json output")
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

    #[test]
    fn small_text_without_paging_returns_full_content_only() {
        let root = test_root("small-root");
        let path = root.join("small.txt");
        fs::write(&path, "one\ntwo\n").expect("write test file");

        let result = execute(
            root.clone(),
            ReadToolArguments {
                path: "small.txt".to_string(),
                offset: None,
                limit: None,
            },
            true,
            false,
        )
        .expect("read result");
        let output = parse_output(result.output);

        assert_eq!(output["content"], "one\ntwo\n");
        assert!(output.get("type").is_none());
        assert!(output.get("offset").is_none());
        assert!(output.get("next").is_none());
        assert!(output.get("truncated").is_none());
        assert!(output.get("startLine").is_none());
        assert!(output.get("endLine").is_none());
        assert!(output.get("totalLines").is_none());

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn paging_request_returns_text_page_for_small_text() {
        let root = test_root("paged-root");
        let path = root.join("paged.txt");
        fs::write(&path, "one\ntwo\nthree").expect("write test file");

        let result = execute(
            root.clone(),
            ReadToolArguments {
                path: "paged.txt".to_string(),
                offset: Some(2),
                limit: Some(1),
            },
            true,
            false,
        )
        .expect("read result");
        let output = parse_output(result.output);

        assert_eq!(output["type"], "text-page");
        assert_eq!(output["content"], "two");
        assert_eq!(output["mime"], "text/plain");
        assert_eq!(output["offset"], 2);
        assert_eq!(output["truncated"], true);
        assert_eq!(output["next"], 3);

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn large_text_without_requested_paging_returns_first_page() {
        let root = test_root("large-text-root");
        let path = root.join("large.txt");
        let content = (1..=2_100)
            .map(|line| format!("{line:04} abcdefghijklmnopqrstuvwxyz"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(content.len() > 51_200);
        fs::write(&path, content).expect("write test file");

        let result = execute(
            root.clone(),
            ReadToolArguments {
                path: "large.txt".to_string(),
                offset: None,
                limit: None,
            },
            true,
            false,
        )
        .expect("read result");
        let output = parse_output(result.output);
        let page_content = output["content"].as_str().expect("page content");

        assert_eq!(output["type"], "text-page");
        assert_eq!(output["offset"], 1);
        assert_eq!(page_content.lines().count(), 2_000);
        assert_eq!(output["truncated"], true);
        assert_eq!(output["next"], 2_001);

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn paging_caps_limit_at_max_read_lines() {
        let root = test_root("many-lines-root");
        let path = root.join("many-lines.txt");
        let content = (1..=2_101)
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&path, content).expect("write test file");

        let result = execute(
            root.clone(),
            ReadToolArguments {
                path: "many-lines.txt".to_string(),
                offset: Some(1),
                limit: Some(3_000),
            },
            true,
            false,
        )
        .expect("read result");
        let output = parse_output(result.output);
        let page_content = output["content"].as_str().expect("page content");

        assert_eq!(page_content.lines().count(), 2_000);
        assert_eq!(output["truncated"], true);
        assert_eq!(output["next"], 2_001);

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn paging_truncates_long_lines() {
        let root = test_root("long-line-root");
        let path = root.join("long-line.txt");
        fs::write(&path, "a".repeat(2_100)).expect("write test file");

        let result = execute(
            root.clone(),
            ReadToolArguments {
                path: "long-line.txt".to_string(),
                offset: Some(1),
                limit: Some(1),
            },
            true,
            false,
        )
        .expect("read result");
        let output = parse_output(result.output);
        let page_content = output["content"].as_str().expect("page content");

        assert!(page_content.starts_with(&"a".repeat(2_000)));
        assert!(page_content.ends_with("... (line truncated to 2000 chars)"));

        fs::remove_dir_all(root).expect("remove test root");
    }
}
