use reqwest::Url;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, time::Duration};

use crate::workspace::paths::{ensure_dir, wizzle_root_dir};

const TOKENIZER_MAX_BYTES: usize = 64 * 1024 * 1024;
const TOKENIZER_MIN_BYTES: usize = 64;

#[derive(Clone, Copy, Debug)]
pub enum TokenizerScope<'a> {
    Provider,
    Model { model_id: &'a str },
}

fn tokenizers_root() -> Result<PathBuf, String> {
    let root = wizzle_root_dir()?.join("tokenizers");
    ensure_dir(&root)?;
    Ok(root)
}

pub fn provider_tokenizer_dir(provider_id: &str) -> Result<PathBuf, String> {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return Err("Provider id is required for tokenizer storage.".to_string());
    }

    let dir = tokenizers_root()?.join(provider_id);
    ensure_dir(&dir)?;
    Ok(dir)
}

fn model_file_name(model_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(model_id.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("model-{}.json", &digest[..16])
}

pub fn local_tokenizer_path(
    provider_id: &str,
    scope: TokenizerScope<'_>,
) -> Result<PathBuf, String> {
    let dir = provider_tokenizer_dir(provider_id)?;
    Ok(match scope {
        TokenizerScope::Provider => dir.join("provider.json"),
        TokenizerScope::Model { model_id } => {
            let models_dir = dir.join("models");
            ensure_dir(&models_dir)?;
            models_dir.join(model_file_name(model_id))
        }
    })
}

pub fn normalize_tokenizer_source(source: Option<String>) -> Option<String> {
    source.and_then(|value| {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

pub fn validate_tokenizer_bytes(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < TOKENIZER_MIN_BYTES {
        return Err("Tokenizer file is too small to be a valid tokenizer.json.".to_string());
    }

    if bytes.len() > TOKENIZER_MAX_BYTES {
        return Err("Tokenizer file is too large (max 64MB).".to_string());
    }

    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| "Tokenizer file is not valid JSON.".to_string())?;

    let object = value
        .as_object()
        .ok_or_else(|| "Tokenizer JSON must be an object.".to_string())?;

    let has_model = object
        .get("model")
        .map(|entry| entry.is_object() || entry.is_string())
        .unwrap_or(false);
    let has_vocab = object.contains_key("vocab");
    let model_has_vocab = object
        .get("model")
        .and_then(|entry| entry.as_object())
        .map(|model| model.contains_key("vocab") || model.contains_key("type"))
        .unwrap_or(false);

    if !has_model && !has_vocab && !model_has_vocab {
        return Err(
            "Tokenizer JSON must look like a HuggingFace tokenizer.json (expected model/vocab)."
                .to_string(),
        );
    }

    Ok(())
}

fn candidate_local_paths(raw_path: &str) -> Vec<PathBuf> {
    let path = PathBuf::from(raw_path);

    if path.is_absolute() {
        return vec![path];
    }

    let mut candidates = Vec::new();

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join(&path));
        candidates.push(current_dir.join("..").join(&path));
        candidates.push(current_dir.join("..").join("..").join(&path));
    }

    if let Ok(root) = wizzle_root_dir() {
        candidates.push(root.join(&path));
    }

    candidates
}

fn read_local_tokenizer_source(raw_path: &str) -> Result<Vec<u8>, String> {
    for path in candidate_local_paths(raw_path) {
        if !path.is_file() {
            continue;
        }

        let metadata = fs::metadata(&path)
            .map_err(|_| "Could not read tokenizer file metadata.".to_string())?;

        if metadata.len() as usize > TOKENIZER_MAX_BYTES {
            return Err("Tokenizer file is too large (max 64MB).".to_string());
        }

        return fs::read(&path).map_err(|_| "Could not read tokenizer file.".to_string());
    }

    Err(format!("Tokenizer file was not found: {raw_path}"))
}

fn download_tokenizer_url(url: &str) -> Result<Vec<u8>, String> {
    let parsed = Url::parse(url).map_err(|_| "Tokenizer URL must be a valid URL.".to_string())?;

    if parsed.scheme() != "https"
        && parsed.host_str() != Some("127.0.0.1")
        && parsed.host_str() != Some("localhost")
    {
        return Err("Tokenizer URL must use HTTPS, except localhost development URLs.".to_string());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|_| "Could not create tokenizer download client.".to_string())?;

    let response = client
        .get(parsed)
        .send()
        .map_err(|_| "Could not download tokenizer.json.".to_string())?;

    if !response.status().is_success() {
        return Err(format!(
            "Tokenizer download failed with HTTP {}.",
            response.status().as_u16()
        ));
    }

    let bytes = response
        .bytes()
        .map_err(|_| "Could not read tokenizer download body.".to_string())?;

    if bytes.len() > TOKENIZER_MAX_BYTES {
        return Err("Tokenizer file is too large (max 64MB).".to_string());
    }

    Ok(bytes.to_vec())
}

fn load_tokenizer_source_bytes(source: &str) -> Result<Vec<u8>, String> {
    let trimmed = source.trim();

    if trimmed.starts_with("https://")
        || trimmed.starts_with("http://")
        || trimmed.starts_with("HTTPS://")
        || trimmed.starts_with("HTTP://")
    {
        if trimmed.to_ascii_lowercase().starts_with("http://")
            && !trimmed.contains("127.0.0.1")
            && !trimmed.to_ascii_lowercase().contains("localhost")
        {
            return Err("Tokenizer URL must use HTTPS, except localhost.".to_string());
        }

        return download_tokenizer_url(trimmed);
    }

    read_local_tokenizer_source(trimmed)
}

/// Download or copy `source` (path/URL), validate HuggingFace-style tokenizer.json, write cache.
pub fn materialize_tokenizer(
    provider_id: &str,
    scope: TokenizerScope<'_>,
    source: &str,
) -> Result<PathBuf, String> {
    let bytes = load_tokenizer_source_bytes(source)?;
    validate_tokenizer_bytes(&bytes)?;

    let path = local_tokenizer_path(provider_id, scope)?;
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }

    fs::write(&path, bytes).map_err(|_| "Could not store tokenizer.json locally.".to_string())?;
    Ok(path)
}

pub fn clear_tokenizer(provider_id: &str, scope: TokenizerScope<'_>) -> Result<(), String> {
    let path = local_tokenizer_path(provider_id, scope)?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|_| "Could not remove cached tokenizer.json.".to_string())?;
    }
    Ok(())
}

pub fn cleanup_provider_tokenizers(provider_id: &str) -> Result<(), String> {
    let dir = tokenizers_root()?.join(provider_id.trim());
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|_| "Could not remove provider tokenizer cache.".to_string())?;
    }
    Ok(())
}

pub fn resolve_local_path_if_present(
    provider_id: &str,
    scope: TokenizerScope<'_>,
    source: Option<&str>,
) -> Option<String> {
    let source = source?.trim();
    if source.is_empty() {
        return None;
    }

    let path = local_tokenizer_path(provider_id, scope).ok()?;
    if path.is_file() {
        Some(path.to_string_lossy().to_string())
    } else {
        None
    }
}

pub fn read_tokenizer_asset(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Tokenizer path is empty.".to_string());
    }

    let path = PathBuf::from(trimmed);
    let root = tokenizers_root()?;
    let canonical = path
        .canonicalize()
        .map_err(|_| "Tokenizer file was not found.".to_string())?;
    let root_canonical = root
        .canonicalize()
        .map_err(|_| "Tokenizer storage is not available.".to_string())?;

    if !canonical.starts_with(&root_canonical) {
        return Err("Tokenizer path is outside the Wizzle tokenizer cache.".to_string());
    }

    if !canonical.is_file() {
        return Err("Tokenizer file was not found.".to_string());
    }

    let metadata = fs::metadata(&canonical)
        .map_err(|_| "Could not read tokenizer file metadata.".to_string())?;
    if metadata.len() as usize > TOKENIZER_MAX_BYTES {
        return Err("Tokenizer file is too large.".to_string());
    }

    fs::read_to_string(&canonical).map_err(|_| "Could not read tokenizer file.".to_string())
}

#[cfg(test)]
mod tests {
    use super::{local_tokenizer_path, validate_tokenizer_bytes, TokenizerScope};

    #[test]
    fn validates_minimal_hf_tokenizer_json() {
        let json = br#"{"version":"1.0","model":{"type":"BPE","vocab":{"a":0},"merges":[]}}"#;
        assert!(validate_tokenizer_bytes(json).is_ok());
    }

    #[test]
    fn rejects_non_tokenizer_json() {
        let json = br#"{"hello":"world"}"#;
        assert!(validate_tokenizer_bytes(json).is_err());
    }

    #[test]
    fn model_scope_path_is_stable() {
        let first = local_tokenizer_path(
            "prov-1",
            TokenizerScope::Model {
                model_id: "qwen2.5",
            },
        )
        .expect("path");
        let second = local_tokenizer_path(
            "prov-1",
            TokenizerScope::Model {
                model_id: "qwen2.5",
            },
        )
        .expect("path");
        assert_eq!(first, second);
        assert!(first.to_string_lossy().contains("model-"));
    }
}
