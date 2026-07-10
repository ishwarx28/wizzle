use std::{fs, path::Path};

use crate::agent::tools::pathing;
use crate::image_preview::{build_inline_image_payload, file_extension};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{types::AttachmentPreviewPayload, MAX_ATTACHMENT_BYTES};

const MARKDOWN_EXTENSIONS: &[&str] = &["md", "mdx"];
const TEXT_EXTENSIONS: &[&str] = &[
    "bash",
    "c",
    "cjs",
    "cpp",
    "csv",
    "css",
    "dart",
    "dockerfile",
    "env",
    "gitignore",
    "go",
    "gradle",
    "h",
    "html",
    "ipynb",
    "java",
    "js",
    "json",
    "jsx",
    "kt",
    "kts",
    "less",
    "log",
    "lock",
    "mjs",
    "prisma",
    "py",
    "pyi",
    "pyx",
    "rs",
    "sass",
    "scss",
    "sh",
    "sql",
    "svelte",
    "toml",
    "ts",
    "tsx",
    "vue",
    "xml",
    "yaml",
    "yml",
    "zsh",
];
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
const UNSUPPORTED_BINARY_EXTENSIONS: &[&str] = &[
    "avi", "docx", "flac", "m4a", "mkv", "mov", "mp3", "mp4", "pdf", "pptx", "wav", "webm", "xlsx",
];

#[tauri::command]
pub fn read_attachment_previews(
    project_id: String,
    paths: Vec<String>,
    capabilities: Vec<String>,
) -> Result<Vec<AttachmentPreviewPayload>, String> {
    let allow_images = capabilities.iter().any(|capability| capability == "image");
    let project_root = pathing::canonical_project_root(&project_id)?;
    let mut previews = Vec::new();

    for path in paths {
        match build_attachment_preview(&project_root, &path, allow_images) {
            Ok(Some(preview)) => previews.push(preview),
            Ok(None) => {}
            Err(error) => previews.push(build_attachment_error_preview(&path, None, error)),
        }
    }

    Ok(previews)
}

#[tauri::command]
pub fn build_attachment_preview_from_bytes(
    name: String,
    virtual_path: String,
    bytes: Vec<u8>,
    capabilities: Vec<String>,
) -> Result<Option<AttachmentPreviewPayload>, String> {
    let allow_images = capabilities.iter().any(|capability| capability == "image");
    build_attachment_preview_from_bytes_impl(&name, &virtual_path, &bytes, allow_images)
}

fn content_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn is_supported_attachment_image_extension(extension: &str) -> bool {
    IMAGE_EXTENSIONS.contains(&extension)
}

fn is_env_attachment_name(name: &str) -> bool {
    let lower_name = name.to_ascii_lowercase();
    lower_name == ".env" || lower_name.starts_with(".env.")
}

fn is_dockerfile_name(name: &str) -> bool {
    let lower_name = name.to_ascii_lowercase();
    lower_name == "dockerfile" || lower_name.ends_with(".dockerfile")
}

fn is_supported_text_attachment(name: &str, extension: &str) -> bool {
    is_env_attachment_name(name)
        || is_dockerfile_name(name)
        || TEXT_EXTENSIONS.contains(&extension)
        || MARKDOWN_EXTENSIONS.contains(&extension)
}

fn is_sensitive_attachment_name(name: &str) -> bool {
    let lower_name = name.to_ascii_lowercase();

    is_env_attachment_name(&lower_name)
        || matches!(
            lower_name.as_str(),
            ".netrc"
                | ".npmrc"
                | ".pypirc"
                | "credentials"
                | "credentials.json"
                | "id_dsa"
                | "id_ecdsa"
                | "id_ed25519"
                | "id_rsa"
                | "service-account.json"
        )
        || lower_name.ends_with(".key")
        || lower_name.ends_with(".pem")
        || lower_name.ends_with(".p12")
        || lower_name.ends_with(".pfx")
        || lower_name.contains("api_key")
        || lower_name.contains("api-key")
        || lower_name.contains("secret")
        || lower_name.contains("token")
}

fn mime_type_for_attachment(extension: &str, name: &str) -> Option<String> {
    let mime_type = match extension {
        "csv" => "text/csv",
        "gif" => "image/gif",
        "html" => "text/html",
        "ipynb" | "json" => "application/json",
        "jpeg" | "jpg" => "image/jpeg",
        "md" | "mdx" => "text/markdown",
        "png" => "image/png",
        "toml" => "application/toml",
        "webp" => "image/webp",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        _ if is_supported_text_attachment(name, extension) => "text/plain",
        _ => return None,
    };

    Some(mime_type.to_string())
}

fn unsupported_attachment_message(name: &str, extension: &str) -> String {
    if UNSUPPORTED_BINARY_EXTENSIONS.contains(&extension) {
        return format!("{name} is not a supported attachment type.");
    }

    format!("{name} is not a supported text/code file or image attachment.")
}

fn build_attachment_preview(
    project_root: &Path,
    raw_path: &str,
    allow_images: bool,
) -> Result<Option<AttachmentPreviewPayload>, String> {
    let resolved_path = resolve_attachment_source_path(project_root, raw_path)?;
    let path = resolved_path.as_path();
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not inspect attachment {}: {error}", path.display()))?;

    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Ok(Some(build_attachment_error_preview(
            raw_path,
            Some(path),
            format!(
                "{} is larger than 10 MB and cannot be attached.",
                file_name(path)
            ),
        )));
    }

    let extension = file_extension(path.display().to_string().as_str());
    let name = file_name(path);
    let is_sensitive = is_sensitive_attachment_name(&name);
    let mime_type = mime_type_for_attachment(&extension, &name);
    let size_bytes = metadata.len();

    if MARKDOWN_EXTENSIONS.contains(&extension.as_str()) {
        let bytes = fs::read(path)
            .map_err(|error| format!("Could not read attachment {}: {error}", path.display()))?;
        let content = String::from_utf8(bytes.clone()).map_err(|_| {
            format!(
                "{} is a binary file and cannot be attached.",
                file_name(path)
            )
        })?;

        return Ok(Some(AttachmentPreviewPayload {
            content: Some(content),
            content_hash: Some(content_hash(&bytes)),
            error: None,
            id: format!("attachment-preview-{}", file_name(path)),
            image_src: None,
            is_sensitive: Some(is_sensitive),
            kind: "markdown".to_string(),
            language: Some("markdown".to_string()),
            mime_type,
            name: file_name(path),
            original_path: Some(raw_path.to_string()),
            path: resolved_path.to_string_lossy().to_string(),
            preview_metadata: Some(json!({
                "source": "file",
                "sizeBytes": size_bytes,
            })),
            real_path: Some(resolved_path.to_string_lossy().to_string()),
            size_bytes: Some(size_bytes),
            summary: "Markdown attachment".to_string(),
        }));
    }

    if is_supported_text_attachment(&name, &extension) {
        let bytes = fs::read(path)
            .map_err(|error| format!("Could not read attachment {}: {error}", path.display()))?;
        let content = String::from_utf8(bytes.clone()).map_err(|_| {
            format!(
                "{} is a binary file and cannot be attached.",
                file_name(path)
            )
        })?;

        return Ok(Some(AttachmentPreviewPayload {
            content: Some(content),
            content_hash: Some(content_hash(&bytes)),
            error: None,
            id: format!("attachment-preview-{}", file_name(path)),
            image_src: None,
            is_sensitive: Some(is_sensitive),
            kind: "text".to_string(),
            language: Some(infer_language(&extension, &name).to_string()),
            mime_type,
            name: file_name(path),
            original_path: Some(raw_path.to_string()),
            path: resolved_path.to_string_lossy().to_string(),
            preview_metadata: Some(json!({
                "source": "file",
                "sizeBytes": size_bytes,
            })),
            real_path: Some(resolved_path.to_string_lossy().to_string()),
            size_bytes: Some(size_bytes),
            summary: "Text attachment".to_string(),
        }));
    }

    if is_supported_attachment_image_extension(&extension) {
        if !allow_images {
            return Ok(Some(build_attachment_error_preview(
                raw_path,
                Some(path),
                "The selected model supports text attachments only.".to_string(),
            )));
        }

        let bytes = fs::read(path)
            .map_err(|error| format!("Could not read attachment {}: {error}", path.display()))?;

        let preview = build_attachment_preview_from_bytes_impl(
            &file_name(path),
            &resolved_path.to_string_lossy(),
            &bytes,
            true,
        )?;

        return Ok(preview.map(|mut payload| {
            payload.original_path = Some(raw_path.to_string());
            payload.real_path = Some(resolved_path.to_string_lossy().to_string());
            payload.preview_metadata = Some(json!({
                "source": "file",
                "sizeBytes": bytes.len(),
            }));
            payload
        }));
    }

    Ok(Some(build_attachment_error_preview(
        raw_path,
        Some(path),
        unsupported_attachment_message(&name, &extension),
    )))
}

fn build_attachment_preview_from_bytes_impl(
    name: &str,
    virtual_path: &str,
    bytes: &[u8],
    allow_images: bool,
) -> Result<Option<AttachmentPreviewPayload>, String> {
    let extension = file_extension(name);
    let is_sensitive = is_sensitive_attachment_name(name);
    let mime_type = mime_type_for_attachment(&extension, name);

    if MARKDOWN_EXTENSIONS.contains(&extension.as_str()) {
        let content = String::from_utf8(bytes.to_vec())
            .map_err(|error| format!("Could not read attachment {name}: {error}"))?;

        return Ok(Some(AttachmentPreviewPayload {
            content: Some(content),
            content_hash: Some(content_hash(bytes)),
            error: None,
            id: format!("attachment-preview-{}", name),
            image_src: None,
            is_sensitive: Some(is_sensitive),
            kind: "markdown".to_string(),
            language: Some("markdown".to_string()),
            mime_type,
            name: name.to_string(),
            original_path: Some(virtual_path.to_string()),
            path: virtual_path.to_string(),
            preview_metadata: Some(json!({
                "source": "bytes",
                "sizeBytes": bytes.len(),
            })),
            real_path: None,
            size_bytes: Some(bytes.len() as u64),
            summary: "Markdown attachment".to_string(),
        }));
    }

    if is_supported_text_attachment(name, &extension) {
        let content = String::from_utf8(bytes.to_vec())
            .map_err(|error| format!("Could not read attachment {name}: {error}"))?;

        return Ok(Some(AttachmentPreviewPayload {
            content: Some(content),
            content_hash: Some(content_hash(bytes)),
            error: None,
            id: format!("attachment-preview-{}", name),
            image_src: None,
            is_sensitive: Some(is_sensitive),
            kind: "text".to_string(),
            language: Some(infer_language(&extension, name).to_string()),
            mime_type,
            name: name.to_string(),
            original_path: Some(virtual_path.to_string()),
            path: virtual_path.to_string(),
            preview_metadata: Some(json!({
                "source": "bytes",
                "sizeBytes": bytes.len(),
            })),
            real_path: None,
            size_bytes: Some(bytes.len() as u64),
            summary: "Text attachment".to_string(),
        }));
    }

    if is_supported_attachment_image_extension(&extension) {
        if !allow_images {
            return Ok(Some(build_attachment_error_preview(
                virtual_path,
                None,
                "The selected model supports text attachments only.".to_string(),
            )));
        }

        let image = build_inline_image_payload(name, bytes)?;

        return Ok(image.map(|payload| AttachmentPreviewPayload {
            content: None,
            content_hash: Some(content_hash(bytes)),
            error: None,
            id: format!("attachment-preview-{}", name),
            image_src: Some(payload.image_src),
            is_sensitive: Some(false),
            kind: "image".to_string(),
            language: None,
            mime_type: Some(payload.mime_type),
            name: name.to_string(),
            original_path: Some(virtual_path.to_string()),
            path: virtual_path.to_string(),
            preview_metadata: Some(json!({
                "source": "bytes",
                "sizeBytes": bytes.len(),
            })),
            real_path: None,
            size_bytes: Some(bytes.len() as u64),
            summary: "Image attachment".to_string(),
        }));
    }

    Ok(Some(build_attachment_error_preview(
        virtual_path,
        None,
        unsupported_attachment_message(name, &extension),
    )))
}

fn build_attachment_error_preview(
    raw_path: &str,
    resolved_path: Option<&Path>,
    message: String,
) -> AttachmentPreviewPayload {
    let path = resolved_path
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| raw_path.to_string());
    let name = resolved_path
        .map(file_name)
        .unwrap_or_else(|| file_name(Path::new(raw_path)));

    AttachmentPreviewPayload {
        content: Some(message.clone()),
        content_hash: None,
        error: Some(message.clone()),
        id: format!("attachment-preview-error-{}", name),
        image_src: None,
        is_sensitive: Some(false),
        kind: "other".to_string(),
        language: Some("text".to_string()),
        mime_type: Some("text/plain".to_string()),
        name,
        original_path: Some(raw_path.to_string()),
        path,
        preview_metadata: None,
        real_path: resolved_path.map(|value| value.to_string_lossy().to_string()),
        size_bytes: None,
        summary: message,
    }
}

fn resolve_attachment_source_path(
    project_root: &Path,
    raw_path: &str,
) -> Result<std::path::PathBuf, String> {
    let raw_candidate = Path::new(raw_path);

    if raw_candidate.is_absolute() && raw_candidate.exists() && raw_candidate.is_file() {
        return std::fs::canonicalize(raw_candidate).map_err(|error| {
            format!(
                "Could not read attachment {}: {error}",
                raw_candidate.display()
            )
        });
    }

    pathing::resolve_existing_path(project_root, raw_path)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| "attachment".to_string())
}

fn infer_language(extension: &str, name: &str) -> &'static str {
    match extension {
        "bash" | "sh" | "zsh" => "bash",
        "c" => "c",
        "cjs" | "js" | "mjs" => "javascript",
        "cpp" => "cpp",
        "csv" => "csv",
        "css" => "css",
        "dart" => "dart",
        "go" => "go",
        "gradle" | "kt" | "kts" => "kotlin",
        "h" => "c",
        "html" => "html",
        "ipynb" | "json" => "json",
        "java" => "java",
        "jsx" => "jsx",
        "less" => "less",
        "md" | "mdx" => "markdown",
        "prisma" => "prisma",
        "py" | "pyi" | "pyx" => "python",
        "rs" => "rust",
        "sass" => "sass",
        "scss" => "scss",
        "sql" => "sql",
        "svelte" => "svelte",
        "toml" => "toml",
        "ts" => "typescript",
        "tsx" => "tsx",
        "vue" => "vue",
        "yaml" | "yml" => "yaml",
        "xml" => "xml",
        _ if is_env_attachment_name(name) => "dotenv",
        _ if is_dockerfile_name(name) => "dockerfile",
        _ => "text",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_phase_seven_text_attachments() {
        assert!(is_supported_text_attachment("main.dart", "dart"));
        assert!(is_supported_text_attachment("notebook.ipynb", "ipynb"));
        assert!(is_supported_text_attachment(".env.local", "local"));
        assert!(is_supported_text_attachment("Dockerfile", ""));
        assert!(is_supported_text_attachment("Gemfile.lock", "lock"));
    }

    #[test]
    fn detects_sensitive_attachment_names() {
        assert!(is_sensitive_attachment_name(".env"));
        assert!(is_sensitive_attachment_name(".env.production"));
        assert!(is_sensitive_attachment_name("id_rsa"));
        assert!(is_sensitive_attachment_name("service-account.json"));
        assert!(is_sensitive_attachment_name("prod-api-key.pem"));
    }

    #[test]
    fn limits_attachment_images_to_phase_seven_formats() {
        assert!(is_supported_attachment_image_extension("png"));
        assert!(is_supported_attachment_image_extension("webp"));
        assert!(!is_supported_attachment_image_extension("svg"));
        assert!(!is_supported_attachment_image_extension("avif"));
    }
}
