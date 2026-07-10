use reqwest::Url;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, sync::Mutex};
use uuid::Uuid;

use crate::workspace::sqlite_repository::{db_error, now_unix_ms, open_database};

use super::{
    crypto::{decrypt_api_key, encrypt_api_key, payload_needs_migration},
    openai_compatible,
    tokenizer_assets::{
        self, cleanup_provider_tokenizers, clear_tokenizer, materialize_tokenizer,
        normalize_tokenizer_source, resolve_local_path_if_present, TokenizerScope,
    },
    types::{
        ImportProviderYamlInput, ProviderModelDefinitionInput, ProviderModelPayload,
        ProviderModelRecord, ProviderPayload, ProviderResolvedModel, ProviderSecretRecord,
        RefreshProviderModelsInput, UpsertProviderInput,
    },
};

const DEFAULT_CONTEXT_TOKENS: u64 = 128_000;
const DEFAULT_REASONING_LEVELS: &[&str] = &["low", "medium", "high", "max", "xhigh"];
const PROVIDER_YAML_MAX_BYTES: usize = 512 * 1024;
const PROVIDER_YAML_PATH_ENV: &str = "WIZZLE_PROVIDERS_YAML_PATH";
const PROVIDER_YAML_INLINE_ENV: &str = "WIZZLE_PROVIDERS_YAML";
const DEFAULT_PROVIDERS_YAML_NAME: &str = "opencode-models.yaml";
static PROVIDER_STARTUP_IMPORT_LOCK: Mutex<()> = Mutex::new(());

pub fn migrate_provider_api_key_encryption() -> Result<usize, String> {
    let mut conn = open_database()?;
    let encrypted_keys = {
        let mut statement = conn
            .prepare(
                "SELECT id, api_key_encrypted FROM providers WHERE api_key_encrypted IS NOT NULL",
            )
            .map_err(|error| db_error("Could not prepare provider key migration", error))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|error| db_error("Could not read provider keys for migration", error))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| db_error("Could not parse provider keys for migration", error))?
    };
    let migrations = encrypted_keys
        .into_iter()
        .filter(|(_, payload)| !payload.is_empty() && payload_needs_migration(payload))
        .map(|(provider_id, payload)| {
            let api_key = decrypt_api_key(Some(payload))?
                .ok_or_else(|| "Could not migrate an empty provider API key.".to_string())?;
            Ok((provider_id, encrypt_api_key(&api_key)?))
        })
        .collect::<Result<Vec<_>, String>>()?;

    if migrations.is_empty() {
        return Ok(0);
    }

    let migration_count = migrations.len();
    let tx = conn
        .transaction()
        .map_err(|error| db_error("Could not start provider key migration", error))?;
    for (provider_id, payload) in migrations {
        tx.execute(
            "UPDATE providers SET api_key_encrypted = ?1 WHERE id = ?2",
            params![payload, provider_id],
        )
        .map_err(|error| db_error("Could not migrate a provider key", error))?;
    }
    tx.commit()
        .map_err(|error| db_error("Could not finish provider key migration", error))?;
    Ok(migration_count)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderYamlFile {
    providers: Vec<ProviderYamlEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderYamlEntry {
    api_key: Option<String>,
    default_model_id: Option<String>,
    endpoint: String,
    models: Option<Vec<ProviderModelDefinitionInput>>,
    name: String,
    only_specified_models: Option<bool>,
    #[serde(alias = "type")]
    provider_type: String,
    tokenizer_json: Option<String>,
}

fn normalize_provider_type(provider_type: &str) -> Option<&'static str> {
    match provider_type.trim().to_ascii_lowercase().as_str() {
        "custom" | "custom_openai" | "custom-openai-compatible" => Some("custom_openai_compatible"),
        "openai-compatible" | "openai_compatible" => Some("openai_compatible"),
        "openai" => Some("openai"),
        _ => None,
    }
}

fn validate_provider_type(provider_type: &str) -> Result<String, String> {
    normalize_provider_type(provider_type)
        .map(str::to_string)
        .ok_or_else(|| "Choose an OpenAI-compatible provider type.".to_string())
}

fn validate_endpoint(endpoint: &str) -> Result<String, String> {
    let endpoint = endpoint.trim().trim_end_matches('/').to_string();

    if endpoint.is_empty() {
        return Err("Provider endpoint is required.".to_string());
    }

    let url =
        Url::parse(&endpoint).map_err(|_| "Provider endpoint must be a valid URL.".to_string())?;

    if url.scheme() != "https"
        && url.host_str() != Some("127.0.0.1")
        && url.host_str() != Some("localhost")
    {
        return Err(
            "Provider endpoint must use HTTPS, except localhost development URLs.".to_string(),
        );
    }

    Ok(endpoint)
}

fn normalize_list(values: Option<Vec<String>>, defaults: &[&str]) -> Vec<String> {
    let values = values.unwrap_or_else(|| defaults.iter().map(|entry| entry.to_string()).collect());
    let mut normalized = Vec::new();

    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() || normalized.iter().any(|entry| entry == trimmed) {
            continue;
        }
        normalized.push(trimmed.to_string());
    }

    if normalized.is_empty() {
        defaults.iter().map(|entry| entry.to_string()).collect()
    } else {
        normalized
    }
}

fn normalize_capabilities(capabilities: Option<Vec<String>>) -> Vec<String> {
    let mut normalized = normalize_list(capabilities, &["text"]);

    if !normalized.iter().any(|entry| entry == "text") {
        normalized.insert(0, "text".to_string());
    }

    normalized
}

fn serialize_string_list(values: &[String]) -> Result<String, String> {
    serde_json::to_string(values).map_err(|_| "Could not save provider model metadata.".to_string())
}

fn deserialize_string_list(raw_value: String, fallback: &[&str]) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(&raw_value)
        .unwrap_or_else(|_| fallback.iter().map(|entry| entry.to_string()).collect())
}

fn source_hash(source: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn validate_yaml_source(source: &str) -> Result<(), String> {
    if source.len() > PROVIDER_YAML_MAX_BYTES {
        return Err("Provider YAML is too large.".to_string());
    }

    Ok(())
}

fn candidate_yaml_paths(raw_path: &str) -> Vec<PathBuf> {
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

    candidates
}

fn read_provider_yaml_path(raw_path: &str) -> Result<String, String> {
    let trimmed_path = raw_path.trim();

    if trimmed_path.is_empty() {
        return Err("Provider YAML path is empty.".to_string());
    }

    for path in candidate_yaml_paths(trimmed_path) {
        if !path.is_file() {
            continue;
        }

        let metadata = fs::metadata(&path)
            .map_err(|_| "Could not read provider YAML metadata.".to_string())?;

        if metadata.len() as usize > PROVIDER_YAML_MAX_BYTES {
            return Err("Provider YAML is too large.".to_string());
        }

        return fs::read_to_string(&path)
            .map_err(|_| "Could not read provider YAML file.".to_string());
    }

    Err("Provider YAML file was not found.".to_string())
}

fn insert_or_update_model(
    conn: &Connection,
    provider_id: &str,
    model: ProviderModelRecord,
) -> Result<(), String> {
    let now = now_unix_ms() as i64;
    let model_uuid = Uuid::new_v4().to_string();
    let capabilities = serialize_string_list(&model.capabilities)?;
    let reasoning_levels = serialize_string_list(&model.reasoning_levels)?;
    let tokenizer_json = normalize_tokenizer_source(model.tokenizer_json.clone());
    let tokenizer_kind = model
        .tokenizer_kind
        .clone()
        .or_else(|| tokenizer_json.as_ref().map(|_| "hf-json".to_string()));

    conn.execute(
        "
        INSERT INTO models (
          id,
          provider_id,
          model_id,
          display_name,
          capabilities,
          reasoning_levels,
          max_context,
          max_output_tokens,
          tokenizer_kind,
          tokenizer_json,
          created_at,
          updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(provider_id, model_id) DO UPDATE SET
          display_name = excluded.display_name,
          capabilities = excluded.capabilities,
          reasoning_levels = excluded.reasoning_levels,
          max_context = excluded.max_context,
          max_output_tokens = excluded.max_output_tokens,
          tokenizer_kind = excluded.tokenizer_kind,
          tokenizer_json = excluded.tokenizer_json,
          updated_at = excluded.updated_at
        ",
        params![
            model_uuid,
            provider_id,
            model.model_id,
            model.display_name,
            capabilities,
            reasoning_levels,
            model.max_context.map(|value| value as i64).unwrap_or(0),
            model.max_output_tokens.map(|value| value as i64),
            tokenizer_kind,
            tokenizer_json,
            now,
            now
        ],
    )
    .map_err(|error| db_error("Could not save provider model", error))?;

    Ok(())
}

fn insert_discovered_model(
    conn: &Connection,
    provider_id: &str,
    model: ProviderModelRecord,
) -> Result<(), String> {
    let now = now_unix_ms() as i64;
    conn.execute(
        "
        INSERT OR IGNORE INTO models (
          id, provider_id, model_id, display_name, capabilities, reasoning_levels,
          max_context, max_output_tokens, tokenizer_kind, tokenizer_json, created_at, updated_at
        ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, 0, NULL, NULL, NULL, ?6, ?6)
        ",
        params![
            Uuid::new_v4().to_string(),
            provider_id,
            model.model_id,
            serialize_string_list(&model.capabilities)?,
            serialize_string_list(&model.reasoning_levels)?,
            now,
        ],
    )
    .map_err(|error| db_error("Could not save discovered provider model", error))?;
    Ok(())
}

fn sync_model_tokenizer_asset(
    provider_id: &str,
    model_id: &str,
    tokenizer_json: Option<&str>,
) -> Result<(), String> {
    let scope = TokenizerScope::Model { model_id };
    match normalize_tokenizer_source(tokenizer_json.map(|value| value.to_string())) {
        Some(source) => {
            materialize_tokenizer(provider_id, scope, &source)?;
        }
        None => {
            clear_tokenizer(provider_id, scope)?;
        }
    }
    Ok(())
}

fn sync_provider_tokenizer_asset(
    provider_id: &str,
    tokenizer_json: Option<&str>,
) -> Result<(), String> {
    match normalize_tokenizer_source(tokenizer_json.map(|value| value.to_string())) {
        Some(source) => {
            materialize_tokenizer(provider_id, TokenizerScope::Provider, &source)?;
        }
        None => {
            clear_tokenizer(provider_id, TokenizerScope::Provider)?;
        }
    }
    Ok(())
}

pub fn model_from_definition(
    input: ProviderModelDefinitionInput,
) -> Result<ProviderModelRecord, String> {
    let model_id = input.model_id.trim().to_string();

    if model_id.is_empty() {
        return Err("Provider model id is required.".to_string());
    }

    let tokenizer_json = normalize_tokenizer_source(input.tokenizer_json);
    let tokenizer_kind = input
        .tokenizer_kind
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .or_else(|| tokenizer_json.as_ref().map(|_| "hf-json".to_string()));

    Ok(ProviderModelRecord {
        capabilities: normalize_capabilities(input.capabilities),
        display_name: input.display_name.and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }),
        max_context: Some(input.max_context.unwrap_or(DEFAULT_CONTEXT_TOKENS)),
        max_output_tokens: input.max_output_tokens,
        model_id,
        reasoning_levels: normalize_list(input.reasoning_levels, DEFAULT_REASONING_LEVELS),
        tokenizer_json,
        tokenizer_kind,
    })
}

fn save_provider_with_conn(
    conn: &Connection,
    input: UpsertProviderInput,
) -> Result<String, String> {
    let provider_id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let name = input.name.trim().to_string();
    let provider_type = validate_provider_type(&input.provider_type)?;
    let endpoint = validate_endpoint(&input.endpoint)?;
    let tokenizer_json = normalize_tokenizer_source(input.tokenizer_json);
    let now = now_unix_ms() as i64;

    if name.is_empty() {
        return Err("Provider name is required.".to_string());
    }

    // Validate + cache tokenizer assets before writing DB so a bad URL fails the save.
    sync_provider_tokenizer_asset(&provider_id, tokenizer_json.as_deref())?;

    let models = input
        .models
        .unwrap_or_default()
        .into_iter()
        .map(model_from_definition)
        .collect::<Result<Vec<_>, _>>()?;

    for model in &models {
        sync_model_tokenizer_asset(
            &provider_id,
            &model.model_id,
            model.tokenizer_json.as_deref(),
        )?;
    }

    let existing_api_key: Option<Vec<u8>> = conn
        .query_row(
            "SELECT api_key_encrypted FROM providers WHERE id = ?1",
            params![provider_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| db_error("Could not read provider API key", error))?;

    let api_key_encrypted = match input.api_key {
        Some(api_key) if !api_key.trim().is_empty() => Some(encrypt_api_key(api_key.trim())?),
        Some(_) => None,
        None => existing_api_key,
    };

    conn.execute(
        "
        INSERT INTO providers (
          id,
          name,
          type,
          endpoint,
          api_key_encrypted,
          default_model_id,
          tokenizer_json,
          created_at,
          updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          endpoint = excluded.endpoint,
          api_key_encrypted = excluded.api_key_encrypted,
          default_model_id = excluded.default_model_id,
          tokenizer_json = excluded.tokenizer_json,
          updated_at = excluded.updated_at
        ",
        params![
            provider_id,
            name,
            provider_type,
            endpoint,
            api_key_encrypted,
            input.default_model_id,
            tokenizer_json,
            now,
            now
        ],
    )
    .map_err(|error| db_error("Could not save provider", error))?;

    for model in models {
        insert_or_update_model(conn, &provider_id, model)?;
    }

    Ok(provider_id)
}

pub fn upsert_provider(input: UpsertProviderInput) -> Result<String, String> {
    let conn = open_database()?;
    save_provider_with_conn(&conn, input)
}

pub fn delete_provider(provider_id: &str) -> Result<(), String> {
    let conn = open_database()?;
    conn.execute("DELETE FROM providers WHERE id = ?1", params![provider_id])
        .map_err(|error| db_error("Could not delete provider", error))?;
    // Best-effort: DB row is already gone even if cache cleanup fails.
    let _ = cleanup_provider_tokenizers(provider_id);
    Ok(())
}

pub fn list_providers() -> Result<Vec<ProviderPayload>, String> {
    import_env_yaml_once()?;
    let conn = open_database()?;
    let mut statement = conn
        .prepare(
            "
            SELECT
              providers.id,
              providers.name,
              providers.type,
              providers.endpoint,
              providers.api_key_encrypted IS NOT NULL,
              providers.default_model_id,
              providers.tokenizer_json,
              providers.created_at,
              providers.updated_at,
              COUNT(models.id)
            FROM providers
            LEFT JOIN models ON models.provider_id = providers.id
            GROUP BY providers.id
            ORDER BY providers.name COLLATE NOCASE
            ",
        )
        .map_err(|error| db_error("Could not list providers", error))?;

    let providers = statement
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let tokenizer_json: Option<String> = row.get(6)?;
            Ok(ProviderPayload {
                id: id.clone(),
                name: row.get(1)?,
                provider_type: row.get(2)?,
                endpoint: row.get(3)?,
                has_api_key: row.get::<_, i64>(4)? != 0,
                default_model_id: row.get(5)?,
                tokenizer_json: tokenizer_json.clone(),
                tokenizer_local_path: resolve_local_path_if_present(
                    &id,
                    TokenizerScope::Provider,
                    tokenizer_json.as_deref(),
                ),
                created_at_ms: row.get::<_, i64>(7)? as u64,
                updated_at_ms: row.get::<_, i64>(8)? as u64,
                model_count: row.get::<_, i64>(9)? as u64,
            })
        })
        .map_err(|error| db_error("Could not read providers", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not read providers", error))?;

    Ok(providers)
}

pub fn list_models() -> Result<Vec<ProviderModelPayload>, String> {
    import_env_yaml_once()?;
    let conn = open_database()?;
    let mut statement = conn
        .prepare(
            "
            SELECT
              models.id,
              models.provider_id,
              providers.name,
              providers.type,
              models.model_id,
              models.display_name,
              models.capabilities,
              models.reasoning_levels,
              models.max_context,
              models.max_output_tokens,
              models.tokenizer_kind,
              models.tokenizer_json,
              models.is_pinned,
              models.last_used_at
            FROM models
            JOIN providers ON providers.id = models.provider_id
            ORDER BY providers.name COLLATE NOCASE, models.model_id COLLATE NOCASE
            ",
        )
        .map_err(|error| db_error("Could not list provider models", error))?;

    let models = statement
        .query_map([], |row| {
            let provider_id: String = row.get(1)?;
            let model_id: String = row.get(4)?;
            let tokenizer_json: Option<String> = row.get(11)?;
            Ok(ProviderModelPayload {
                id: row.get(0)?,
                provider_id: provider_id.clone(),
                provider_name: row.get(2)?,
                provider_type: row.get(3)?,
                model_id: model_id.clone(),
                display_name: row.get(5)?,
                capabilities: deserialize_string_list(row.get(6)?, &["text"]),
                reasoning_levels: deserialize_string_list(row.get(7)?, DEFAULT_REASONING_LEVELS),
                max_context: match row.get::<_, i64>(8)? {
                    value if value > 0 => Some(value as u64),
                    _ => None,
                },
                max_output_tokens: row.get::<_, Option<i64>>(9)?.map(|value| value as u64),
                tokenizer_kind: row.get(10)?,
                tokenizer_json: tokenizer_json.clone(),
                tokenizer_local_path: resolve_local_path_if_present(
                    &provider_id,
                    TokenizerScope::Model {
                        model_id: model_id.as_str(),
                    },
                    tokenizer_json.as_deref(),
                ),
                is_pinned: row.get::<_, i64>(12)? != 0,
                last_used_at_ms: row.get::<_, Option<i64>>(13)?.map(|value| value as u64),
            })
        })
        .map_err(|error| db_error("Could not read provider models", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not read provider models", error))?;

    Ok(models)
}

pub async fn refresh_provider_models(
    input: RefreshProviderModelsInput,
) -> Result<Vec<ProviderModelPayload>, String> {
    // None selected → intentional no-op (I-25).
    if !input.fetch_all && !input.remove_invalid {
        return list_models();
    }

    let provider = load_provider_secret(&input.provider_id)?;

    if !matches!(
        provider.provider_type.as_str(),
        "openai" | "openai_compatible" | "custom_openai_compatible"
    ) {
        return Err("Model refresh is not available for this provider type yet.".to_string());
    }

    let remote_models = openai_compatible::fetch_models(&provider).await?;
    let conn = open_database()?;
    let remote_ids: std::collections::HashSet<String> = remote_models
        .iter()
        .map(|model| model.model_id.clone())
        .collect();

    if input.fetch_all {
        for model in remote_models {
            // Catalog entries only prove that an id exists. Preserve all explicit local metadata.
            insert_discovered_model(&conn, &provider.id, model)?;
        }
    }

    if input.remove_invalid {
        let local_model_ids: Vec<String> = {
            let mut statement = conn
                .prepare("SELECT model_id FROM models WHERE provider_id = ?1")
                .map_err(|error| db_error("Could not list local models for refresh", error))?;
            let rows = statement
                .query_map(params![provider.id], |row| row.get::<_, String>(0))
                .map_err(|error| db_error("Could not list local models for refresh", error))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| db_error("Could not list local models for refresh", error))?
        };

        for model_id in local_model_ids {
            if remote_ids.contains(&model_id) {
                continue;
            }

            conn.execute(
                "DELETE FROM models WHERE provider_id = ?1 AND model_id = ?2",
                params![provider.id, model_id],
            )
            .map_err(|error| db_error("Could not remove invalid provider model", error))?;
            let _ = clear_tokenizer(
                &provider.id,
                TokenizerScope::Model {
                    model_id: model_id.as_str(),
                },
            );
        }
    }

    list_models()
}

pub fn read_tokenizer_asset(path: &str) -> Result<String, String> {
    tokenizer_assets::read_tokenizer_asset(path)
}

pub fn import_provider_yaml(input: ImportProviderYamlInput) -> Result<(), String> {
    validate_yaml_source(&input.yaml)?;
    let source = input.source.unwrap_or_else(|| "manual".to_string());
    import_provider_yaml_text(&input.yaml, &source)
}

pub fn import_provider_yaml_text(yaml: &str, source: &str) -> Result<(), String> {
    validate_yaml_source(yaml)?;
    let parsed = serde_yaml::from_str::<ProviderYamlFile>(yaml)
        .map_err(|_| "Provider YAML could not be parsed.".to_string())?;

    if parsed.providers.is_empty() {
        return Err("Provider YAML must contain at least one provider.".to_string());
    }

    let conn = open_database()?;
    let hash = source_hash(yaml);
    let provider_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM providers", [], |row| row.get(0))
        .map_err(|error| db_error("Could not count providers", error))?;

    let already_imported: Option<String> = conn
        .query_row(
            "SELECT id FROM provider_imports WHERE source_hash = ?1",
            params![hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| db_error("Could not read provider imports", error))?;

    // Skip duplicate imports only when providers already exist (I-14: allow re-seed when empty).
    if already_imported.is_some() && provider_count > 0 {
        return Ok(());
    }

    for provider in parsed.providers {
        let models = provider.models.unwrap_or_default();
        let default_model_id = provider.default_model_id.or_else(|| {
            models
                .first()
                .map(|model| model.model_id.trim().to_string())
                .filter(|value| !value.is_empty())
        });

        let provider_id = save_provider_with_conn(
            &conn,
            UpsertProviderInput {
                api_key: provider.api_key,
                default_model_id,
                endpoint: provider.endpoint,
                id: None,
                models: Some(models),
                name: provider.name,
                only_specified_models: provider.only_specified_models,
                provider_type: provider.provider_type,
                tokenizer_json: provider.tokenizer_json,
            },
        )?;

        if provider_id.is_empty() {
            return Err("Provider YAML could not be imported.".to_string());
        }
    }

    conn.execute(
        "
        INSERT INTO provider_imports (id, source, source_hash, imported_at)
        VALUES (?1, ?2, ?3, ?4)
        ",
        params![
            Uuid::new_v4().to_string(),
            source,
            hash,
            now_unix_ms() as i64
        ],
    )
    .map_err(|error| db_error("Could not record provider import", error))?;

    Ok(())
}

fn candidate_default_provider_yaml_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join(DEFAULT_PROVIDERS_YAML_NAME));
        candidates.push(current_dir.join("..").join(DEFAULT_PROVIDERS_YAML_NAME));
        candidates.push(
            current_dir
                .join("..")
                .join("..")
                .join(DEFAULT_PROVIDERS_YAML_NAME),
        );
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(DEFAULT_PROVIDERS_YAML_NAME));
            candidates.push(parent.join("..").join(DEFAULT_PROVIDERS_YAML_NAME));
            candidates.push(parent.join("Resources").join(DEFAULT_PROVIDERS_YAML_NAME));
        }
    }

    candidates
}

/// I-14: when the providers table is empty, import a default YAML once.
fn seed_default_providers_if_empty() -> Result<(), String> {
    let conn = open_database()?;
    let provider_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM providers", [], |row| row.get(0))
        .map_err(|error| db_error("Could not count providers", error))?;

    if provider_count > 0 {
        return Ok(());
    }

    drop(conn);

    for path in candidate_default_provider_yaml_paths() {
        if !path.is_file() {
            continue;
        }

        let yaml = fs::read_to_string(&path)
            .map_err(|_| "Could not read the default providers YAML.".to_string())?;
        return import_provider_yaml_text(&yaml, "seed:default-providers");
    }

    import_provider_yaml_text(
        include_str!("../../../../opencode-models.yaml"),
        "seed:embedded-default-providers",
    )
}

pub fn import_env_yaml_once() -> Result<(), String> {
    let _guard = PROVIDER_STARTUP_IMPORT_LOCK
        .lock()
        .map_err(|_| "Could not initialize default providers.".to_string())?;
    // Always try to seed defaults when the DB has zero providers (I-14).
    seed_default_providers_if_empty()?;

    let (yaml_source, source_name) = match std::env::var(PROVIDER_YAML_PATH_ENV) {
        Ok(value) if !value.trim().is_empty() => (
            read_provider_yaml_path(&value)?,
            format!("env:{PROVIDER_YAML_PATH_ENV}"),
        ),
        _ => match std::env::var(PROVIDER_YAML_INLINE_ENV) {
            Ok(value) if !value.trim().is_empty() => {
                (value, format!("env:{PROVIDER_YAML_INLINE_ENV}"))
            }
            _ => return Ok(()),
        },
    };

    let conn = open_database()?;
    let import_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM provider_imports", [], |row| {
            row.get(0)
        })
        .map_err(|error| db_error("Could not read provider imports", error))?;
    let provider_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM providers", [], |row| row.get(0))
        .map_err(|error| db_error("Could not count providers", error))?;

    if import_count > 0 && provider_count > 0 {
        return Ok(());
    }

    drop(conn);

    if yaml_source.trim_start().starts_with("http://") {
        return Err("WIZZLE_PROVIDERS_YAML remote imports must use HTTPS.".to_string());
    }

    if yaml_source.trim_start().starts_with("https://") {
        return Err(
            "Remote provider YAML import is available through the manual import command."
                .to_string(),
        );
    }

    import_provider_yaml_text(&yaml_source, &source_name)
}

pub fn load_provider_secret(provider_id: &str) -> Result<ProviderSecretRecord, String> {
    let conn = open_database()?;
    let provider = conn
        .query_row(
            "
            SELECT id, name, type, endpoint, api_key_encrypted
            FROM providers
            WHERE id = ?1
            ",
            params![provider_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<Vec<u8>>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| db_error("Could not read provider", error))?;

    let Some((id, name, provider_type, endpoint, encrypted_api_key)) = provider else {
        return Err("Provider is no longer available.".to_string());
    };

    Ok(ProviderSecretRecord {
        api_key: decrypt_api_key(encrypted_api_key)?,
        endpoint,
        id,
        name,
        provider_type,
    })
}

pub fn resolve_model(model_uuid: &str) -> Result<ProviderResolvedModel, String> {
    let conn = open_database()?;
    let row = conn
        .query_row(
            "
            SELECT
              models.id,
              models.provider_id,
              providers.name,
              providers.type,
              providers.endpoint,
              providers.api_key_encrypted,
              models.model_id,
              models.display_name,
              models.capabilities,
              models.reasoning_levels,
              models.max_context,
              models.max_output_tokens,
              models.tokenizer_kind
            FROM models
            JOIN providers ON providers.id = models.provider_id
            WHERE models.id = ?1
            ",
            params![model_uuid],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<Vec<u8>>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, Option<i64>>(11)?,
                    row.get::<_, Option<String>>(12)?,
                ))
            },
        )
        .optional()
        .map_err(|error| db_error("Could not read selected model", error))?;

    let Some((
        resolved_model_uuid,
        provider_id,
        provider_name,
        provider_type,
        endpoint,
        encrypted_api_key,
        model_id,
        display_name,
        capabilities,
        reasoning_levels,
        max_context,
        max_output_tokens,
        tokenizer_kind,
    )) = row
    else {
        return Err("Selected model is no longer available.".to_string());
    };

    Ok(ProviderResolvedModel {
        model_uuid: resolved_model_uuid,
        model: ProviderModelRecord {
            capabilities: deserialize_string_list(capabilities, &["text"]),
            display_name,
            max_context: if max_context > 0 {
                Some(max_context as u64)
            } else {
                None
            },
            max_output_tokens: max_output_tokens.map(|value| value as u64),
            model_id,
            reasoning_levels: deserialize_string_list(reasoning_levels, DEFAULT_REASONING_LEVELS),
            tokenizer_json: None,
            tokenizer_kind,
        },
        provider: ProviderSecretRecord {
            api_key: decrypt_api_key(encrypted_api_key)?,
            endpoint,
            id: provider_id,
            name: provider_name,
            provider_type,
        },
    })
}

pub fn mark_model_used(model_uuid: &str) -> Result<(), String> {
    let conn = open_database()?;
    conn.execute(
        "UPDATE models SET last_used_at = ?1 WHERE id = ?2",
        params![now_unix_ms() as i64, model_uuid],
    )
    .map_err(|error| db_error("Could not update selected model", error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        import_provider_yaml_text, insert_discovered_model, model_from_definition,
        validate_provider_type,
    };
    use crate::providers::types::{ProviderModelDefinitionInput, ProviderModelRecord};
    use rusqlite::{params, Connection};

    #[test]
    fn model_definition_normalizes_defaults() {
        let model = model_from_definition(ProviderModelDefinitionInput {
            capabilities: Some(vec!["image".to_string()]),
            display_name: None,
            max_context: None,
            max_output_tokens: None,
            model_id: "gpt-test".to_string(),
            reasoning_levels: None,
            tokenizer_kind: None,
            tokenizer_json: None,
        })
        .expect("model definition");

        assert_eq!(model.model_id, "gpt-test");
        assert_eq!(model.max_context, Some(128_000));
        assert_eq!(model.capabilities, vec!["text", "image"]);
        assert_eq!(
            model.reasoning_levels,
            vec!["low", "medium", "high", "max", "xhigh"]
        );
    }

    #[test]
    fn model_definition_empty_capabilities_defaults_to_text() {
        let model = model_from_definition(ProviderModelDefinitionInput {
            capabilities: Some(vec![]),
            display_name: None,
            max_context: None,
            max_output_tokens: None,
            model_id: "gpt-empty-caps".to_string(),
            reasoning_levels: None,
            tokenizer_kind: None,
            tokenizer_json: None,
        })
        .expect("model definition");

        assert_eq!(model.capabilities, vec!["text"]);
    }

    #[test]
    fn model_definition_blank_capabilities_defaults_to_text() {
        let model = model_from_definition(ProviderModelDefinitionInput {
            capabilities: Some(vec!["".to_string(), "   ".to_string()]),
            display_name: None,
            max_context: None,
            max_output_tokens: None,
            model_id: "gpt-blank-caps".to_string(),
            reasoning_levels: None,
            tokenizer_kind: None,
            tokenizer_json: None,
        })
        .expect("model definition");

        assert_eq!(model.capabilities, vec!["text"]);
    }

    #[test]
    fn provider_yaml_rejects_empty_provider_list() {
        let result = import_provider_yaml_text("providers: []", "test");

        assert!(result.is_err());
    }

    #[test]
    fn embedded_default_provider_yaml_is_available() {
        let parsed = serde_yaml::from_str::<super::ProviderYamlFile>(include_str!(
            "../../../../opencode-models.yaml"
        ))
        .expect("embedded default provider YAML");

        assert!(!parsed.providers.is_empty());
        assert!(parsed.providers.iter().all(|provider| {
            validate_provider_type(&provider.provider_type).is_ok()
                && !provider.models.as_deref().unwrap_or_default().is_empty()
        }));
    }

    #[test]
    fn rejects_unimplemented_and_unknown_provider_types() {
        assert!(validate_provider_type("anthropic").is_err());
        assert!(validate_provider_type("google").is_err());
        assert!(validate_provider_type("openai_compatble").is_err());
        assert_eq!(
            validate_provider_type("openai-compatible").as_deref(),
            Ok("openai_compatible")
        );
    }

    #[test]
    fn discovered_model_does_not_overwrite_configured_metadata() {
        let conn = Connection::open_in_memory().expect("in-memory database");
        conn.execute_batch(
            "
            CREATE TABLE models (
              id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
              display_name TEXT NULL, capabilities TEXT NOT NULL, reasoning_levels TEXT NOT NULL,
              max_context INTEGER NOT NULL, max_output_tokens INTEGER NULL,
              tokenizer_kind TEXT NULL, tokenizer_json TEXT NULL,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              UNIQUE(provider_id, model_id)
            );
            ",
        )
        .expect("model table");
        conn.execute(
            "INSERT INTO models VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, 1)",
            params![
                "model-uuid",
                "provider-1",
                "custom-model",
                "Custom name",
                r#"["text","image"]"#,
                r#"["low"]"#,
                32_000,
                4_096,
                "hf-json",
                "https://example.com/tokenizer.json",
            ],
        )
        .expect("configured model");

        insert_discovered_model(
            &conn,
            "provider-1",
            ProviderModelRecord {
                capabilities: Vec::new(),
                display_name: None,
                max_context: None,
                max_output_tokens: None,
                model_id: "custom-model".to_string(),
                reasoning_levels: Vec::new(),
                tokenizer_json: None,
                tokenizer_kind: None,
            },
        )
        .expect("catalog refresh");

        let metadata = conn
            .query_row(
                "SELECT display_name, capabilities, reasoning_levels, max_context, max_output_tokens, tokenizer_kind, tokenizer_json FROM models",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?)),
            )
            .expect("preserved metadata");

        assert_eq!(metadata.0, "Custom name");
        assert_eq!(metadata.1, r#"["text","image"]"#);
        assert_eq!(metadata.2, r#"["low"]"#);
        assert_eq!(metadata.3, 32_000);
        assert_eq!(metadata.4, 4_096);
        assert_eq!(metadata.5, "hf-json");
        assert_eq!(metadata.6, "https://example.com/tokenizer.json");
    }
}
