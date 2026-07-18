use reqwest::Url;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::{BTreeMap, HashMap, HashSet};
use uuid::Uuid;

use crate::workspace::sqlite_repository::{
    db_error, now_unix_ms, open_database, open_write_database,
};

use super::{
    anthropic,
    crypto::{decrypt_api_key, encrypt_api_key},
    google, openai_compatible,
    reasoning::{
        deserialize_reasoning_config, serialize_reasoning_config, validate_provider_request_fields,
        validate_reasoning_config,
    },
    types::{
        ManagedProviderDefinition, ProviderHeaderInput, ProviderModelDefinitionInput,
        ProviderModelPayload, ProviderModelRecord, ProviderPayload, ProviderRequestFieldInput,
        ProviderResolvedModel, ProviderSecretRecord, RefreshProviderModelsInput,
        SetupManagedProviderInput, UpdateManagedProviderApiKeyInput, UpsertProviderInput,
    },
};

const MAX_CUSTOM_HEADERS: usize = 32;
const MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;

fn normalize_provider_type(provider_type: &str) -> Option<&'static str> {
    match provider_type.trim().to_ascii_lowercase().as_str() {
        "custom" | "custom_openai" | "custom-openai-compatible" | "custom_openai_compatible" => {
            Some("custom_openai_compatible")
        }
        "openai-compatible" | "openai_compatible" => Some("openai_compatible"),
        "openai" => Some("openai"),
        "anthropic" | "claude" => Some("anthropic"),
        "google" | "gemini" | "google_gemini" | "google-gemini" => Some("google"),
        _ => None,
    }
}

fn validate_provider_type(provider_type: &str) -> Result<String, String> {
    normalize_provider_type(provider_type)
        .map(str::to_string)
        .ok_or_else(|| {
            "Choose an OpenAI-compatible, Anthropic, or Google provider type.".to_string()
        })
}

pub(crate) fn validate_endpoint(endpoint: &str) -> Result<String, String> {
    let endpoint = endpoint.trim().trim_end_matches('/').to_string();
    if endpoint.is_empty() {
        return Err("Provider endpoint is required.".to_string());
    }

    let url =
        Url::parse(&endpoint).map_err(|_| "Provider endpoint must be a valid URL.".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Provider endpoint must not include credentials.".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Provider endpoint must not include a query or fragment.".to_string());
    }

    let endpoint_path = url.path().trim_end_matches('/').to_ascii_lowercase();
    if endpoint_path.ends_with("/models")
        || endpoint_path.ends_with("/chat/completions")
        || endpoint_path.ends_with("/messages")
        || endpoint_path.ends_with(":generatecontent")
        || endpoint_path.ends_with(":streamgeneratecontent")
    {
        return Err(
            "Provider endpoint must be an API base URL, not a model or generation endpoint."
                .to_string(),
        );
    }

    let is_localhost = matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "::1" | "[::1]")
    );
    if url.scheme() != "https" && !(url.scheme() == "http" && is_localhost) {
        return Err(
            "Provider endpoint must use HTTPS, except localhost development URLs.".to_string(),
        );
    }
    Ok(endpoint)
}

fn validate_optional_limit(value: Option<u64>, label: &str) -> Result<Option<i64>, String> {
    if matches!(value, Some(0)) || value.is_some_and(|entry| entry > i64::MAX as u64) {
        return Err(format!("{label} must be a positive supported integer."));
    }
    Ok(value.map(|entry| entry as i64))
}

fn normalize_capabilities(capabilities: Option<Vec<String>>) -> Vec<String> {
    let mut normalized = Vec::new();
    for capability in capabilities.unwrap_or_else(|| vec!["text".to_string()]) {
        let capability = capability.trim().to_ascii_lowercase();
        if matches!(capability.as_str(), "text" | "image" | "audio" | "video")
            && !normalized.contains(&capability)
        {
            normalized.push(capability);
        }
    }
    if !normalized.iter().any(|value| value == "text") {
        normalized.insert(0, "text".to_string());
    }
    normalized
}

pub(crate) fn normalize_headers(
    headers: Vec<ProviderHeaderInput>,
) -> Result<Vec<ProviderHeaderInput>, String> {
    if headers.len() > MAX_CUSTOM_HEADERS {
        return Err(format!(
            "A provider can define at most {MAX_CUSTOM_HEADERS} custom headers."
        ));
    }
    let mut names = HashSet::new();
    let mut normalized = Vec::with_capacity(headers.len());
    for header in headers {
        let name = header.name.trim().to_string();
        let value = header.value.trim().to_string();
        if name.is_empty()
            || !name.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(
                        byte,
                        b'!' | b'#'
                            | b'$'
                            | b'%'
                            | b'&'
                            | b'\''
                            | b'*'
                            | b'+'
                            | b'-'
                            | b'.'
                            | b'^'
                            | b'_'
                            | b'`'
                            | b'|'
                            | b'~'
                    )
            })
        {
            return Err("Custom header names must use valid HTTP token characters.".to_string());
        }
        if value.len() > MAX_HEADER_VALUE_BYTES || value.contains(['\r', '\n']) {
            return Err(format!("Custom header {name} has an invalid value."));
        }
        let lower_name = name.to_ascii_lowercase();
        if matches!(
            lower_name.as_str(),
            "connection" | "content-length" | "host" | "transfer-encoding"
        ) {
            return Err(format!("Custom header {name} is managed by Wizzle."));
        }
        if !names.insert(lower_name) {
            return Err(format!("Custom header {name} is listed more than once."));
        }
        normalized.push(ProviderHeaderInput { name, value });
    }
    Ok(normalized)
}

fn normalize_request_fields(
    fields: Vec<ProviderRequestFieldInput>,
) -> Result<Vec<ProviderRequestFieldInput>, String> {
    let fields = fields
        .into_iter()
        .map(|field| ProviderRequestFieldInput {
            path: field.path.trim().to_string(),
            value: field.value,
        })
        .collect::<Vec<_>>();
    validate_provider_request_fields(&fields)?;
    Ok(fields)
}

fn serialize_json<T: serde::Serialize>(value: &T, context: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| format!("Could not save {context}."))
}

fn deserialize_json<T: serde::de::DeserializeOwned + Default>(raw: String) -> T {
    serde_json::from_str(&raw).unwrap_or_default()
}

fn reasoning_levels(model: &ProviderModelRecord) -> Vec<String> {
    model
        .reasoning
        .as_ref()
        .map(|config| {
            config
                .variants
                .iter()
                .map(|variant| variant.id.clone())
                .collect()
        })
        .unwrap_or_default()
}

fn model_from_definition(
    input: ProviderModelDefinitionInput,
) -> Result<ProviderModelRecord, String> {
    let model_id = input.model_id.trim().to_string();
    if model_id.is_empty() {
        return Err("Provider model id is required.".to_string());
    }
    for (label, value) in [
        ("Max context", input.max_context),
        ("Max output tokens", input.max_output_tokens),
    ] {
        if matches!(value, Some(0)) || value.is_some_and(|entry| entry > i64::MAX as u64) {
            return Err(format!(
                "{label} for {model_id} must be a positive supported integer."
            ));
        }
    }
    let reasoning = validate_reasoning_config(input.reasoning)?;
    Ok(ProviderModelRecord {
        capabilities: normalize_capabilities(input.capabilities),
        display_name: input.display_name.and_then(|value| {
            let value = value.trim().to_string();
            (!value.is_empty()).then_some(value)
        }),
        max_context: input.max_context,
        max_output_tokens: input.max_output_tokens,
        model_id,
        reasoning,
        reasoning_levels: Vec::new(),
    })
}

fn insert_or_update_model(
    conn: &Connection,
    provider_id: &str,
    mut model: ProviderModelRecord,
) -> Result<(), String> {
    model.reasoning = validate_reasoning_config(model.reasoning)?;
    model.reasoning_levels = reasoning_levels(&model);
    let now = now_unix_ms() as i64;
    conn.execute(
        "
        INSERT INTO models (
          id, provider_id, model_id, display_name, capabilities, reasoning_levels,
          reasoning_config, max_context, max_output_tokens, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
        ON CONFLICT(provider_id, model_id) DO UPDATE SET
          display_name = excluded.display_name,
          capabilities = excluded.capabilities,
          reasoning_levels = excluded.reasoning_levels,
          reasoning_config = excluded.reasoning_config,
          max_context = excluded.max_context,
          max_output_tokens = excluded.max_output_tokens,
          updated_at = excluded.updated_at
        ",
        params![
            Uuid::new_v4().to_string(),
            provider_id,
            model.model_id,
            model.display_name,
            serialize_json(&model.capabilities, "provider model capabilities")?,
            serialize_json(&model.reasoning_levels, "provider model reasoning levels")?,
            serialize_reasoning_config(model.reasoning.as_ref())?,
            model.max_context.map(|value| value as i64).unwrap_or(0),
            model.max_output_tokens.map(|value| value as i64),
            now,
        ],
    )
    .map_err(|error| db_error("Could not save provider model", error))?;
    Ok(())
}

fn insert_discovered_model(
    conn: &Connection,
    provider_id: &str,
    mut model: ProviderModelRecord,
) -> Result<(), String> {
    model.reasoning = None;
    model.reasoning_levels.clear();
    let capabilities = normalize_capabilities(Some(model.capabilities));
    let now = now_unix_ms() as i64;
    conn.execute(
        "
        INSERT OR IGNORE INTO models (
          id, provider_id, model_id, display_name, capabilities, reasoning_levels,
          reasoning_config, max_context, max_output_tokens, created_at, updated_at
        ) VALUES (?1, ?2, ?3, NULL, ?4, '[]', NULL, 0, NULL, ?5, ?5)
        ",
        params![
            Uuid::new_v4().to_string(),
            provider_id,
            model.model_id,
            serialize_json(&capabilities, "provider model capabilities")?,
            now,
        ],
    )
    .map_err(|error| db_error("Could not save discovered provider model", error))?;
    Ok(())
}

fn replace_provider_models(
    conn: &Connection,
    provider_id: &str,
    models: Vec<ProviderModelRecord>,
) -> Result<(), String> {
    let mut model_ids = HashSet::with_capacity(models.len());
    for model in &models {
        if !model_ids.insert(model.model_id.clone()) {
            return Err(format!(
                "Model ID {} is listed more than once.",
                model.model_id
            ));
        }
    }
    for model in models {
        insert_or_update_model(conn, provider_id, model)?;
    }

    let existing_ids = {
        let mut statement = conn
            .prepare("SELECT model_id FROM models WHERE provider_id = ?1")
            .map_err(|error| db_error("Could not compare provider models", error))?;
        let rows = statement
            .query_map(params![provider_id], |row| row.get::<_, String>(0))
            .map_err(|error| db_error("Could not compare provider models", error))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| db_error("Could not compare provider models", error))?
    };
    for model_id in existing_ids {
        if !model_ids.contains(&model_id) {
            conn.execute(
                "DELETE FROM models WHERE provider_id = ?1 AND model_id = ?2",
                params![provider_id, model_id],
            )
            .map_err(|error| db_error("Could not remove provider model", error))?;
        }
    }
    Ok(())
}

fn auth_defaults(provider_type: &str) -> (bool, Option<String>, String) {
    match provider_type {
        "anthropic" => (true, Some("x-api-key".to_string()), String::new()),
        "google" => (true, Some("x-goog-api-key".to_string()), String::new()),
        _ => (
            false,
            Some("Authorization".to_string()),
            "Bearer ".to_string(),
        ),
    }
}

fn save_custom_provider_with_conn(
    conn: &Connection,
    input: UpsertProviderInput,
) -> Result<String, String> {
    let is_edit = input.id.is_some();
    let provider_id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let name = input.name.trim().to_string();
    let provider_type = validate_provider_type(&input.provider_type)?;
    let endpoint = validate_endpoint(&input.endpoint)?;
    let default_max_context =
        validate_optional_limit(input.default_max_context, "Default max context")?;
    let default_max_output_tokens =
        validate_optional_limit(input.default_max_output_tokens, "Default max output tokens")?;
    let default_model_id = input.default_model_id.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    });
    let headers = normalize_headers(input.headers)?;
    let request_fields = normalize_request_fields(input.request_fields)?;
    let replace_models = input
        .replace_models
        .unwrap_or(input.only_specified_models.unwrap_or(false));
    let models = input
        .models
        .unwrap_or_default()
        .into_iter()
        .map(model_from_definition)
        .collect::<Result<Vec<_>, _>>()?;
    let now = now_unix_ms() as i64;

    if name.is_empty() {
        return Err("Provider name is required.".to_string());
    }
    if replace_models
        && default_model_id
            .as_ref()
            .is_some_and(|id| !models.iter().any(|model| &model.model_id == id))
    {
        return Err("Default model ID must match one of the configured models.".to_string());
    }

    let existing = conn
        .query_row(
            "SELECT api_key_encrypted, managed_config_id FROM providers WHERE id = ?1",
            params![provider_id],
            |row| {
                Ok((
                    row.get::<_, Option<Vec<u8>>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(|error| db_error("Could not read provider", error))?;
    if is_edit && existing.is_none() {
        return Err("Provider is no longer available.".to_string());
    }
    if existing
        .as_ref()
        .and_then(|(_, managed_config_id)| managed_config_id.as_ref())
        .is_some()
    {
        return Err("Managed providers only allow API key changes.".to_string());
    }
    let existing_api_key = existing.and_then(|(api_key, _)| api_key);
    let api_key_encrypted = match input.api_key {
        Some(api_key) if !api_key.trim().is_empty() => Some(encrypt_api_key(api_key.trim())?),
        Some(_) => None,
        None => existing_api_key,
    };
    let (api_key_required, auth_header_name, auth_header_prefix) = auth_defaults(&provider_type);

    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|error| db_error("Could not start provider save", error))?;
    tx.execute(
        "
        INSERT INTO providers (
          id, name, type, endpoint, api_key_encrypted, default_model_id,
          default_max_context, default_max_output_tokens, managed_config_id,
          managed_setup_values, headers, request_fields, api_key_required,
          auth_header_name, auth_header_prefix, chat_completions_path, models_path,
          model_catalog_mode, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, '{}', ?9, ?10, ?11, ?12, ?13, NULL, NULL, 'manual', ?14, ?14)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          endpoint = excluded.endpoint,
          api_key_encrypted = excluded.api_key_encrypted,
          default_model_id = excluded.default_model_id,
          default_max_context = excluded.default_max_context,
          default_max_output_tokens = excluded.default_max_output_tokens,
          headers = excluded.headers,
          request_fields = excluded.request_fields,
          api_key_required = excluded.api_key_required,
          auth_header_name = excluded.auth_header_name,
          auth_header_prefix = excluded.auth_header_prefix,
          chat_completions_path = NULL,
          models_path = NULL,
          model_catalog_mode = 'manual',
          updated_at = excluded.updated_at
        ",
        params![
            provider_id,
            name,
            provider_type,
            endpoint,
            api_key_encrypted,
            default_model_id,
            default_max_context,
            default_max_output_tokens,
            serialize_json(&headers, "provider headers")?,
            serialize_json(&request_fields, "provider request fields")?,
            api_key_required as i64,
            auth_header_name,
            auth_header_prefix,
            now,
        ],
    )
    .map_err(|error| {
        if matches!(
            error,
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error {
                    code: rusqlite::ErrorCode::ConstraintViolation,
                    ..
                },
                _
            )
        ) {
            "A provider with this name already exists.".to_string()
        } else {
            db_error("Could not save provider", error)
        }
    })?;

    for model in models.iter().cloned() {
        insert_or_update_model(&tx, &provider_id, model)?;
    }
    if replace_models {
        replace_provider_models(&tx, &provider_id, models)?;
    }
    tx.commit()
        .map_err(|error| db_error("Could not finish provider save", error))?;
    Ok(provider_id)
}

pub fn upsert_provider(input: UpsertProviderInput) -> Result<String, String> {
    let conn = open_write_database()?;
    save_custom_provider_with_conn(&conn, input)
}

fn encode_path_segment(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn resolve_managed_endpoint(
    definition: &ManagedProviderDefinition,
    setup_values: &BTreeMap<String, String>,
) -> Result<String, String> {
    let known_fields = definition
        .setup_fields
        .iter()
        .map(|field| field.id.as_str())
        .collect::<HashSet<_>>();
    if setup_values
        .keys()
        .any(|id| !known_fields.contains(id.as_str()))
    {
        return Err("Managed provider setup contains an unsupported field.".to_string());
    }
    let mut endpoint = definition.endpoint_template.clone();
    for field in &definition.setup_fields {
        let value = setup_values
            .get(&field.id)
            .map(|value| value.trim())
            .unwrap_or_default();
        if field.required && value.is_empty() {
            return Err(format!("{} is required.", field.label));
        }
        endpoint = endpoint.replace(
            &format!("{{{{{}}}}}", field.id),
            &encode_path_segment(value),
        );
    }
    if endpoint.contains("{{") || endpoint.contains("}}") {
        return Err("Managed provider endpoint has an unresolved setup value.".to_string());
    }
    validate_endpoint(&endpoint)
}

struct ExistingManagedProvider {
    api_key: Option<Vec<u8>>,
    id: String,
}

fn existing_provider_for_managed(
    conn: &Connection,
    definition: &ManagedProviderDefinition,
) -> Result<Option<ExistingManagedProvider>, String> {
    conn.query_row(
        "SELECT id, api_key_encrypted FROM providers
         WHERE managed_config_id = ?1 OR (managed_config_id IS NULL AND name = ?2)
         ORDER BY managed_config_id IS NOT NULL DESC LIMIT 1",
        params![definition.config_id, definition.name],
        |row| {
            Ok(ExistingManagedProvider {
                id: row.get(0)?,
                api_key: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(|error| db_error("Could not read managed provider", error))
}

fn sync_managed_models(
    conn: &Connection,
    provider_id: &str,
    definition: &ManagedProviderDefinition,
) -> Result<(), String> {
    if definition.model_catalog_mode == "fixed" {
        return replace_provider_models(conn, provider_id, definition.models.clone());
    }

    let existing_ids = {
        let mut statement = conn
            .prepare("SELECT model_id FROM models WHERE provider_id = ?1")
            .map_err(|error| db_error("Could not read live provider models", error))?;
        let rows = statement
            .query_map(params![provider_id], |row| row.get::<_, String>(0))
            .map_err(|error| db_error("Could not read live provider models", error))?;
        rows.collect::<Result<HashSet<_>, _>>()
            .map_err(|error| db_error("Could not parse live provider models", error))?
    };
    for model in definition
        .models
        .iter()
        .filter(|model| existing_ids.contains(&model.model_id))
    {
        insert_or_update_model(conn, provider_id, model.clone())?;
    }
    Ok(())
}

fn save_managed_provider_with_conn(
    conn: &Connection,
    definition: &ManagedProviderDefinition,
    api_key: Option<&str>,
    setup_values: &BTreeMap<String, String>,
    preserve_api_key: bool,
    allow_missing_required_key: bool,
) -> Result<String, String> {
    let endpoint = resolve_managed_endpoint(definition, setup_values)?;
    let existing = existing_provider_for_managed(conn, definition)?;
    let provider_id = existing
        .as_ref()
        .map(|provider| provider.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let existing_api_key = existing.and_then(|provider| provider.api_key);
    let next_api_key = match api_key {
        Some(value) if !value.trim().is_empty() => Some(encrypt_api_key(value.trim())?),
        Some(_) => None,
        None if preserve_api_key => existing_api_key,
        None => None,
    };
    if definition.api_key_required && next_api_key.is_none() && !allow_missing_required_key {
        return Err(format!("{} requires an API key.", definition.name));
    }
    let default_model_id = match definition.default_model_id.as_ref() {
        Some(id) if definition.models.iter().any(|model| &model.model_id == id) => {
            let available = definition.model_catalog_mode == "fixed"
                || conn
                    .query_row(
                        "SELECT 1 FROM models WHERE provider_id = ?1 AND model_id = ?2",
                        params![provider_id, id],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(|error| db_error("Could not read provider default model", error))?
                    .is_some();
            available.then_some(id.clone())
        }
        _ => None,
    };
    let now = now_unix_ms() as i64;
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|error| db_error("Could not start managed provider save", error))?;
    tx.execute(
        "
        INSERT INTO providers (
          id, name, type, endpoint, api_key_encrypted, default_model_id,
          default_max_context, default_max_output_tokens, managed_config_id,
          managed_setup_values, headers, request_fields, api_key_required,
          auth_header_name, auth_header_prefix, chat_completions_path, models_path,
          model_catalog_mode, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '[]', ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          endpoint = excluded.endpoint,
          api_key_encrypted = excluded.api_key_encrypted,
          default_model_id = excluded.default_model_id,
          default_max_context = excluded.default_max_context,
          default_max_output_tokens = excluded.default_max_output_tokens,
          managed_config_id = excluded.managed_config_id,
          managed_setup_values = excluded.managed_setup_values,
          headers = excluded.headers,
          request_fields = '[]',
          api_key_required = excluded.api_key_required,
          auth_header_name = excluded.auth_header_name,
          auth_header_prefix = excluded.auth_header_prefix,
          chat_completions_path = excluded.chat_completions_path,
          models_path = excluded.models_path,
          model_catalog_mode = excluded.model_catalog_mode,
          updated_at = excluded.updated_at
        ",
        params![
            provider_id,
            definition.name,
            definition.provider_type,
            endpoint,
            next_api_key,
            default_model_id,
            definition.default_max_context.map(|value| value as i64),
            definition
                .default_max_output_tokens
                .map(|value| value as i64),
            definition.config_id,
            serialize_json(setup_values, "managed provider setup")?,
            serialize_json(&definition.headers, "managed provider headers")?,
            definition.api_key_required as i64,
            definition.auth_header_name,
            definition.auth_header_prefix,
            definition.chat_completions_path,
            definition.models_path,
            definition.model_catalog_mode,
            now,
        ],
    )
    .map_err(|error| db_error("Could not save managed provider", error))?;
    sync_managed_models(&tx, &provider_id, definition)?;
    tx.commit()
        .map_err(|error| db_error("Could not finish managed provider save", error))?;
    Ok(provider_id)
}

pub fn setup_managed_provider(
    definition: &ManagedProviderDefinition,
    input: SetupManagedProviderInput,
) -> Result<String, String> {
    if input.provider_config_id.trim() != definition.config_id {
        return Err("Managed provider selection is no longer available.".to_string());
    }
    let conn = open_write_database()?;
    save_managed_provider_with_conn(
        &conn,
        definition,
        input.api_key.as_deref(),
        &input.setup_values,
        true,
        false,
    )
}

pub fn sync_managed_catalog(definitions: &[ManagedProviderDefinition]) -> Result<(), String> {
    let conn = open_write_database()?;
    let definitions = definitions
        .iter()
        .map(|definition| (definition.config_id.as_str(), definition))
        .collect::<HashMap<_, _>>();
    let configured = {
        let mut statement = conn
            .prepare(
                "SELECT managed_config_id, managed_setup_values FROM providers
                 WHERE managed_config_id IS NOT NULL",
            )
            .map_err(|error| db_error("Could not prepare managed provider sync", error))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| db_error("Could not read managed providers", error))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| db_error("Could not parse managed providers", error))?
    };
    for (config_id, setup_json) in configured {
        let Some(definition) = definitions.get(config_id.as_str()) else {
            continue;
        };
        let setup_values = deserialize_json::<BTreeMap<String, String>>(setup_json);
        save_managed_provider_with_conn(&conn, definition, None, &setup_values, true, true)?;
    }
    Ok(())
}

pub fn update_managed_provider_api_key(
    input: UpdateManagedProviderApiKeyInput,
) -> Result<(), String> {
    let conn = open_write_database()?;
    let required = conn
        .query_row(
            "SELECT api_key_required FROM providers
             WHERE id = ?1 AND managed_config_id IS NOT NULL",
            params![input.provider_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| db_error("Could not read managed provider", error))?
        .ok_or_else(|| "Managed provider is no longer available.".to_string())?
        != 0;
    let encrypted = match input.api_key {
        Some(value) if !value.trim().is_empty() => Some(encrypt_api_key(value.trim())?),
        Some(_) if required => return Err("This managed provider requires an API key.".to_string()),
        Some(_) => None,
        None => return Ok(()),
    };
    conn.execute(
        "UPDATE providers SET api_key_encrypted = ?1, updated_at = ?2 WHERE id = ?3",
        params![encrypted, now_unix_ms() as i64, input.provider_id],
    )
    .map_err(|error| db_error("Could not update managed provider API key", error))?;
    Ok(())
}

pub fn delete_provider(provider_id: &str) -> Result<(), String> {
    let conn = open_write_database()?;
    conn.execute("DELETE FROM providers WHERE id = ?1", params![provider_id])
        .map_err(|error| db_error("Could not delete provider", error))?;
    Ok(())
}

pub fn list_providers() -> Result<Vec<ProviderPayload>, String> {
    let conn = open_database()?;
    let mut statement = conn
        .prepare(
            "
            SELECT providers.id, providers.name, providers.type, providers.endpoint,
                   providers.api_key_encrypted IS NOT NULL, providers.default_model_id,
                   providers.default_max_context, providers.default_max_output_tokens,
                   providers.managed_config_id, providers.headers, providers.request_fields,
                   providers.model_catalog_mode, providers.created_at, providers.updated_at,
                   COUNT(models.id)
            FROM providers
            LEFT JOIN models ON models.provider_id = providers.id
            GROUP BY providers.id
            ORDER BY providers.name COLLATE NOCASE
            ",
        )
        .map_err(|error| db_error("Could not list providers", error))?;
    let rows = statement
        .query_map([], |row| {
            let managed_config_id = row.get::<_, Option<String>>(8)?;
            Ok(ProviderPayload {
                id: row.get(0)?,
                name: row.get(1)?,
                provider_type: row.get(2)?,
                endpoint: row.get(3)?,
                has_api_key: row.get::<_, i64>(4)? != 0,
                default_model_id: row.get(5)?,
                default_max_context: row.get::<_, Option<i64>>(6)?.map(|value| value as u64),
                default_max_output_tokens: row.get::<_, Option<i64>>(7)?.map(|value| value as u64),
                is_managed: managed_config_id.is_some(),
                managed_config_id,
                headers: deserialize_json(row.get(9)?),
                request_fields: deserialize_json(row.get(10)?),
                can_refresh_models: row.get::<_, String>(11)? == "provider_api",
                created_at_ms: row.get::<_, i64>(12)? as u64,
                updated_at_ms: row.get::<_, i64>(13)? as u64,
                model_count: row.get::<_, i64>(14)? as u64,
            })
        })
        .map_err(|error| db_error("Could not read providers", error))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not parse providers", error))
}

pub fn list_models() -> Result<Vec<ProviderModelPayload>, String> {
    let conn = open_database()?;
    let mut statement = conn
        .prepare(
            "
            SELECT models.id, models.provider_id, providers.name, providers.type,
                   models.model_id, models.display_name, models.capabilities,
                   models.reasoning_levels, models.reasoning_config,
                   CASE WHEN models.max_context > 0 THEN models.max_context
                        ELSE COALESCE(providers.default_max_context, 128000) END,
                   COALESCE(models.max_output_tokens, providers.default_max_output_tokens),
                   NULLIF(models.max_context, 0), models.max_output_tokens,
                   models.is_pinned, models.last_used_at
            FROM models
            JOIN providers ON providers.id = models.provider_id
            ORDER BY providers.name COLLATE NOCASE, models.model_id COLLATE NOCASE
            ",
        )
        .map_err(|error| db_error("Could not list provider models", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ProviderModelPayload {
                id: row.get(0)?,
                provider_id: row.get(1)?,
                provider_name: row.get(2)?,
                provider_type: row.get(3)?,
                model_id: row.get(4)?,
                display_name: row.get(5)?,
                capabilities: deserialize_json(row.get(6)?),
                reasoning_levels: deserialize_json(row.get(7)?),
                reasoning: deserialize_reasoning_config(row.get(8)?),
                max_context: Some(row.get::<_, i64>(9)? as u64),
                max_output_tokens: row.get::<_, Option<i64>>(10)?.map(|value| value as u64),
                configured_max_context: row.get::<_, Option<i64>>(11)?.map(|value| value as u64),
                configured_max_output_tokens: row
                    .get::<_, Option<i64>>(12)?
                    .map(|value| value as u64),
                is_pinned: row.get::<_, i64>(13)? != 0,
                last_used_at_ms: row.get::<_, Option<i64>>(14)?.map(|value| value as u64),
            })
        })
        .map_err(|error| db_error("Could not read provider models", error))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not parse provider models", error))
}

pub fn managed_config_id(provider_id: &str) -> Result<Option<String>, String> {
    open_database()?
        .query_row(
            "SELECT managed_config_id FROM providers WHERE id = ?1",
            params![provider_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| db_error("Could not read provider catalog configuration", error))?
        .ok_or_else(|| "Provider is no longer available.".to_string())
}

pub async fn refresh_provider_models(
    input: RefreshProviderModelsInput,
    managed_definition: Option<&ManagedProviderDefinition>,
) -> Result<Vec<ProviderModelPayload>, String> {
    if !input.fetch_all && !input.remove_invalid {
        return list_models();
    }
    let provider = load_provider_secret(&input.provider_id)?;
    let catalog_mode = open_database()?
        .query_row(
            "SELECT model_catalog_mode FROM providers WHERE id = ?1",
            params![input.provider_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| db_error("Could not read provider", error))?
        .unwrap_or_else(|| "manual".to_string());
    if catalog_mode != "manual" && catalog_mode != "provider_api" {
        return Err("Managed provider models come from the remote Wizzle catalog.".to_string());
    }

    let remote_models = match provider.provider_type.as_str() {
        "anthropic" => anthropic::fetch_models(&provider).await?,
        "google" => google::fetch_models(&provider).await?,
        "openai" | "openai_compatible" | "custom_openai_compatible" => {
            openai_compatible::fetch_models(&provider).await?
        }
        _ => return Err("Model refresh is not available for this provider type.".to_string()),
    };
    let remote_ids = remote_models
        .iter()
        .map(|model| model.model_id.clone())
        .collect::<HashSet<_>>();
    let conn = open_write_database()?;
    let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate)
        .map_err(|error| db_error("Could not start provider model refresh", error))?;
    if input.fetch_all {
        for model in remote_models {
            if let Some(declared) = managed_definition.and_then(|definition| {
                definition
                    .models
                    .iter()
                    .find(|declared| declared.model_id == model.model_id)
            }) {
                insert_or_update_model(&tx, &provider.id, declared.clone())?;
            } else {
                insert_discovered_model(&tx, &provider.id, model)?;
            }
        }
    }
    if input.remove_invalid {
        let local_ids = {
            let mut statement = tx
                .prepare("SELECT model_id FROM models WHERE provider_id = ?1")
                .map_err(|error| db_error("Could not list local models", error))?;
            let rows = statement
                .query_map(params![provider.id], |row| row.get::<_, String>(0))
                .map_err(|error| db_error("Could not list local models", error))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| db_error("Could not parse local models", error))?
        };
        for model_id in local_ids {
            if !remote_ids.contains(&model_id) {
                tx.execute(
                    "DELETE FROM models WHERE provider_id = ?1 AND model_id = ?2",
                    params![provider.id, model_id],
                )
                .map_err(|error| db_error("Could not remove invalid provider model", error))?;
            }
        }
        tx.execute(
            "UPDATE providers SET default_model_id = NULL, updated_at = ?1
             WHERE id = ?2 AND default_model_id IS NOT NULL AND default_model_id NOT IN
               (SELECT model_id FROM models WHERE provider_id = ?2)",
            params![now_unix_ms() as i64, provider.id],
        )
        .map_err(|error| db_error("Could not update provider default model", error))?;
    }
    if let Some(default_model_id) = managed_definition
        .and_then(|definition| definition.default_model_id.as_ref())
        .filter(|model_id| remote_ids.contains(*model_id))
    {
        tx.execute(
            "UPDATE providers SET default_model_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![default_model_id, now_unix_ms() as i64, provider.id],
        )
        .map_err(|error| db_error("Could not update provider default model", error))?;
    }
    tx.commit()
        .map_err(|error| db_error("Could not finish provider model refresh", error))?;
    list_models()
}

pub fn load_provider_secret(provider_id: &str) -> Result<ProviderSecretRecord, String> {
    let conn = open_database()?;
    conn.query_row(
        "
        SELECT id, name, type, endpoint, api_key_encrypted, api_key_required,
               auth_header_name, auth_header_prefix, chat_completions_path, models_path,
               headers, request_fields
        FROM providers WHERE id = ?1
        ",
        params![provider_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<Vec<u8>>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
            ))
        },
    )
    .optional()
    .map_err(|error| db_error("Could not read provider", error))?
    .map(|row| -> Result<ProviderSecretRecord, String> {
        Ok(ProviderSecretRecord {
            id: row.0,
            name: row.1,
            provider_type: row.2,
            endpoint: row.3,
            api_key: decrypt_api_key(row.4)?,
            api_key_required: row.5 != 0,
            auth_header_name: row.6,
            auth_header_prefix: row.7,
            chat_completions_path: row.8,
            models_path: row.9,
            headers: deserialize_json(row.10),
            request_fields: deserialize_json(row.11),
        })
    })
    .transpose()?
    .ok_or_else(|| "Provider is no longer available.".to_string())
}

pub fn resolve_model(model_uuid: &str) -> Result<ProviderResolvedModel, String> {
    let conn = open_database()?;
    let row = conn
        .query_row(
            "
            SELECT models.id, models.provider_id, models.model_id, models.display_name,
                   models.capabilities, models.reasoning_levels, models.reasoning_config,
                   CASE WHEN models.max_context > 0 THEN models.max_context
                        ELSE COALESCE(providers.default_max_context, 128000) END,
                   COALESCE(models.max_output_tokens, providers.default_max_output_tokens)
            FROM models JOIN providers ON providers.id = models.provider_id
            WHERE models.id = ?1
            ",
            params![model_uuid],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                ))
            },
        )
        .optional()
        .map_err(|error| db_error("Could not read selected model", error))?
        .ok_or_else(|| "Selected model is no longer available.".to_string())?;
    let provider = load_provider_secret(&row.1)?;
    Ok(ProviderResolvedModel {
        model_uuid: row.0,
        model: ProviderModelRecord {
            model_id: row.2,
            display_name: row.3,
            capabilities: deserialize_json(row.4),
            reasoning_levels: deserialize_json(row.5),
            reasoning: deserialize_reasoning_config(row.6),
            max_context: (row.7 > 0).then_some(row.7 as u64),
            max_output_tokens: row.8.map(|value| value as u64),
        },
        provider,
    })
}

pub fn mark_model_used(model_uuid: &str) -> Result<(), String> {
    let conn = open_write_database()?;
    conn.execute(
        "UPDATE models SET last_used_at = ?1 WHERE id = ?2",
        params![now_unix_ms() as i64, model_uuid],
    )
    .map_err(|error| db_error("Could not update selected model", error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{normalize_headers, resolve_managed_endpoint, validate_endpoint};
    use crate::providers::types::{
        ManagedProviderDefinition, ManagedProviderSetupField, ProviderHeaderInput,
    };
    use std::collections::BTreeMap;

    #[test]
    fn provider_endpoint_requires_https_except_loopback() {
        assert!(validate_endpoint("https://api.example.test/v1").is_ok());
        assert!(validate_endpoint("http://localhost:11434/v1").is_ok());
        assert!(validate_endpoint("http://api.example.test/v1").is_err());
        assert!(validate_endpoint("https://user:secret@example.test/v1").is_err());
        assert!(validate_endpoint("https://api.example.test/v1/chat/completions").is_err());
    }

    #[test]
    fn custom_headers_reject_transport_owned_values() {
        assert!(normalize_headers(vec![ProviderHeaderInput {
            name: "Content-Length".into(),
            value: "1".into(),
        }])
        .is_err());
    }

    #[test]
    fn managed_endpoint_substitutes_encoded_setup_values() {
        let definition = ManagedProviderDefinition {
            api_key_required: true,
            auth_header_name: Some("Authorization".into()),
            auth_header_prefix: "Bearer ".into(),
            chat_completions_path: Some("/chat/completions".into()),
            config_id: "cloudflare".into(),
            default_max_context: Some(128_000),
            default_max_output_tokens: Some(8_192),
            default_model_id: None,
            endpoint_template: "https://example.test/accounts/{{accountId}}/v1".into(),
            headers: vec![],
            models: vec![],
            model_catalog_mode: "fixed".into(),
            models_path: Some("/models".into()),
            name: "Cloudflare".into(),
            provider_type: "openai_compatible".into(),
            setup_fields: vec![ManagedProviderSetupField {
                id: "accountId".into(),
                label: "Account ID".into(),
                required: true,
                secret: false,
            }],
        };
        let endpoint = resolve_managed_endpoint(
            &definition,
            &BTreeMap::from([("accountId".into(), "abc/123".into())]),
        )
        .expect("endpoint");
        assert_eq!(endpoint, "https://example.test/accounts/abc%2F123/v1");
    }
}
