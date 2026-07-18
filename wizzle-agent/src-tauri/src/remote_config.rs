use futures_util::future::join_all;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    sync::Mutex,
    time::Duration,
};
use tauri::State;

use crate::{
    logging::log_desktop_event,
    providers::{
        reasoning::validate_reasoning_config,
        repository,
        types::{
            ManagedProviderDefinition, ManagedProviderSetupField, ProviderHeaderInput,
            ProviderModelRecord, SetupManagedProviderInput, UpdateManagedProviderApiKeyInput,
        },
    },
    workspace::paths::{ensure_dir, state_dir, wizzle_root_dir, write_json},
};

const APP_CONFIG_MAX_BYTES: usize = 256 * 1024;
const PROVIDER_CONFIG_MAX_BYTES: usize = 2 * 1024 * 1024;
const PROMPT_MAX_BYTES: usize = 128 * 1024;
const CONFIG_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CONFIG_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);
const CACHE_FILE_NAME: &str = "remote-config-cache.json";
const REQUIRED_PROMPTS: &[&str] = &[
    "system",
    "title",
    "enhancement",
    "compaction",
    "explorer",
    "reviewer",
    "worker",
    "final-response",
    "max-steps-final",
    "context-pressure",
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfigManifest {
    schema_version: u32,
    revision: String,
    developer: RemoteDeveloper,
    update: RemoteUpdateManifest,
    prompts: BTreeMap<String, RemoteResourceReference>,
    providers: Vec<RemoteProviderReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteUpdateManifest {
    version: String,
    #[serde(default)]
    url: Option<String>,
    status: String,
    note: String,
    #[serde(default)]
    platforms: BTreeMap<String, RemoteUpdatePlatform>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteUpdatePlatform {
    url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeveloper {
    pub name: String,
    pub email: String,
    pub links: Vec<RemoteDeveloperLink>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeveloperLink {
    pub id: String,
    pub label: String,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteUpdate {
    pub version: String,
    pub url: String,
    pub status: String,
    pub note: String,
    #[serde(default = "default_update_platform")]
    pub platform: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteResourceReference {
    url: String,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteProviderReference {
    id: String,
    name: String,
    config_url: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfigFile {
    schema_version: u32,
    provider: ProviderConfig,
    #[serde(default)]
    reasoning_recipes: BTreeMap<String, crate::providers::reasoning::ModelReasoningConfig>,
    models: Vec<ProviderConfigModel>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfig {
    id: String,
    name: String,
    transport: String,
    endpoint: String,
    auth: ProviderAuth,
    #[serde(default)]
    setup_fields: Vec<ManagedProviderSetupField>,
    defaults: ProviderDefaults,
    model_catalog: ProviderModelCatalog,
    #[serde(default)]
    routes: ProviderRoutes,
    #[serde(default)]
    headers: Vec<ProviderHeaderInput>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRoutes {
    chat_completions: Option<String>,
    models: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderAuth {
    mode: String,
    #[serde(default)]
    required: bool,
    location: Option<String>,
    name: Option<String>,
    #[serde(default)]
    prefix: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderDefaults {
    model_id: Option<String>,
    max_context: Option<u64>,
    max_output_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderModelCatalog {
    mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfigModel {
    model_id: String,
    display_name: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    max_context: Option<u64>,
    max_output_tokens: Option<u64>,
    reasoning_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProviderCatalogPayload {
    pub api_key_required: bool,
    pub id: String,
    pub model_catalog_mode: String,
    pub model_count: usize,
    pub name: String,
    pub setup_fields: Vec<ManagedProviderSetupField>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfigPayload {
    pub developer: RemoteDeveloper,
    pub prompts: BTreeMap<String, String>,
    pub providers: Vec<ManagedProviderCatalogPayload>,
    pub revision: String,
    pub source_url: String,
    pub update: RemoteUpdate,
    pub using_cached_config: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedRemoteConfig {
    developer: RemoteDeveloper,
    prompts: BTreeMap<String, String>,
    providers: Vec<ManagedProviderDefinition>,
    revision: String,
    source_url: String,
    update: RemoteUpdate,
}

impl LoadedRemoteConfig {
    fn payload(&self, using_cached_config: bool) -> RemoteConfigPayload {
        RemoteConfigPayload {
            developer: self.developer.clone(),
            prompts: self.prompts.clone(),
            providers: self
                .providers
                .iter()
                .map(|provider| ManagedProviderCatalogPayload {
                    api_key_required: provider.api_key_required,
                    id: provider.config_id.clone(),
                    model_catalog_mode: provider.model_catalog_mode.clone(),
                    model_count: provider.models.len(),
                    name: provider.name.clone(),
                    setup_fields: provider.setup_fields.clone(),
                })
                .collect(),
            revision: self.revision.clone(),
            source_url: self.source_url.clone(),
            update: self.update.clone(),
            using_cached_config,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadRemoteConfigInput {
    pub url: String,
}

#[derive(Default)]
pub struct RemoteConfigState {
    loaded: Mutex<Option<LoadedRemoteConfig>>,
}

impl RemoteConfigState {
    pub(crate) fn app_update(&self) -> Result<RemoteUpdate, String> {
        let loaded = self
            .loaded
            .lock()
            .map_err(|_| "Could not access the remote configuration.".to_string())?;
        loaded
            .as_ref()
            .map(|config| config.update.clone())
            .ok_or_else(|| {
                "Remote configuration is not loaded. Restart or retry startup.".to_string()
            })
    }

    pub(crate) fn managed_provider(
        &self,
        config_id: &str,
    ) -> Result<Option<ManagedProviderDefinition>, String> {
        let loaded = self
            .loaded
            .lock()
            .map_err(|_| "Could not access the remote configuration.".to_string())?;
        Ok(loaded.as_ref().and_then(|config| {
            config
                .providers
                .iter()
                .find(|provider| provider.config_id == config_id)
                .cloned()
        }))
    }
}

fn validate_https_url(raw_url: &str, label: &str) -> Result<Url, String> {
    let url = Url::parse(raw_url.trim()).map_err(|_| format!("{label} must be a valid URL."))?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err(format!("{label} must use HTTPS."));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!("{label} must not include credentials."));
    }
    Ok(url)
}

fn config_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(CONFIG_CONNECT_TIMEOUT)
        .timeout(CONFIG_DOWNLOAD_TIMEOUT)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.stop();
            }
            let url = attempt.url();
            if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
                return attempt.stop();
            }
            attempt.follow()
        }))
        .user_agent("Wizzle remote configuration")
        .build()
        .map_err(|_| "Could not initialize the remote configuration connection.".to_string())
}

async fn fetch_text(
    client: &reqwest::Client,
    raw_url: &str,
    max_bytes: usize,
    label: &str,
) -> Result<String, String> {
    let url = validate_https_url(raw_url, label)?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| format!("Could not download {label}."))?;
    if response.url().scheme() != "https" {
        return Err(format!("{label} redirected to an insecure URL."));
    }
    if !response.status().is_success() {
        return Err(format!(
            "{label} returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(format!("{label} is larger than Wizzle allows."));
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| format!("Could not read {label}."))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!("{label} is larger than Wizzle allows."));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| format!("{label} must be UTF-8 text."))
}

fn verify_hash(content: &str, expected: &str, label: &str) -> Result<(), String> {
    let actual = format!("{:x}", Sha256::digest(content.as_bytes()));
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{label} has an invalid SHA-256 checksum."));
    }
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(format!("{label} failed its integrity check."));
    }
    Ok(())
}

fn validate_developer(developer: &mut RemoteDeveloper) -> Result<(), String> {
    developer.name = developer.name.trim().to_string();
    developer.email = developer.email.trim().to_string();
    if developer.name.is_empty() {
        return Err("Remote developer name is required.".to_string());
    }
    let Some((local, domain)) = developer.email.split_once('@') else {
        return Err("Remote developer email is invalid.".to_string());
    };
    if local.is_empty() || !domain.contains('.') || domain.ends_with('.') {
        return Err("Remote developer email is invalid.".to_string());
    }
    if developer.links.is_empty() {
        return Err("Remote developer links must not be empty.".to_string());
    }
    let mut ids = HashSet::new();
    for link in &mut developer.links {
        link.id = link.id.trim().to_string();
        link.label = link.label.trim().to_string();
        link.url = validate_https_url(&link.url, "Developer link")?.to_string();
        if link.id.is_empty() || link.label.is_empty() || !ids.insert(link.id.clone()) {
            return Err("Remote developer links contain invalid or duplicate entries.".to_string());
        }
    }
    Ok(())
}

fn current_update_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unsupported"
    }
}

fn default_update_platform() -> String {
    current_update_platform().to_string()
}

fn validate_update(update: &mut RemoteUpdateManifest) -> Result<RemoteUpdate, String> {
    update.version = update.version.trim().to_string();
    update.status = update.status.trim().to_ascii_lowercase();
    update.note = update.note.trim().to_string();
    if update.version.is_empty() || update.note.is_empty() {
        return Err("Remote update version and note are required.".to_string());
    }
    semver::Version::parse(&update.version)
        .map_err(|_| "Remote update version must be valid semantic versioning.".to_string())?;
    if !matches!(update.status.as_str(), "normal" | "critical") {
        return Err("Remote update status must be normal or critical.".to_string());
    }

    let platform = current_update_platform().to_string();
    let url = if update.platforms.is_empty() {
        let legacy_url = update.url.as_deref().ok_or_else(|| {
            "Remote update must contain platform-specific update URLs.".to_string()
        })?;
        validate_https_url(legacy_url, "Update URL")?.to_string()
    } else {
        for (platform_name, platform_update) in &mut update.platforms {
            if !matches!(platform_name.as_str(), "macos" | "windows" | "linux") {
                return Err(format!(
                    "Remote update contains unsupported platform {platform_name}."
                ));
            }
            platform_update.url =
                validate_https_url(&platform_update.url, "Platform update URL")?.to_string();
        }
        update
            .platforms
            .get(&platform)
            .map(|entry| entry.url.clone())
            .ok_or_else(|| format!("Remote update has no URL for {platform}."))?
    };

    Ok(RemoteUpdate {
        version: update.version.clone(),
        url,
        status: update.status.clone(),
        note: update.note.clone(),
        platform,
    })
}

fn transport_type(transport: &str) -> Result<String, String> {
    match transport.trim() {
        "openai_chat_completions" => Ok("openai_compatible".to_string()),
        "anthropic_messages" => Ok("anthropic".to_string()),
        "google_generate_content" => Ok("google".to_string()),
        _ => Err("Remote provider uses an unsupported transport.".to_string()),
    }
}

fn validate_route_path(path: Option<String>, label: &str) -> Result<Option<String>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    let path = path.trim().to_string();
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains(['?', '#'])
        || path.split('/').any(|segment| segment == "..")
    {
        return Err(format!("{label} must be a safe absolute API path."));
    }
    Ok(Some(path))
}

fn parse_provider_config(
    reference: &RemoteProviderReference,
    text: &str,
) -> Result<ManagedProviderDefinition, String> {
    let file = serde_yaml::from_str::<ProviderConfigFile>(text)
        .map_err(|_| format!("Provider configuration {} is invalid.", reference.id))?;
    if file.schema_version != 1 {
        return Err(format!(
            "Provider configuration {} uses an unsupported schema version.",
            reference.id
        ));
    }
    if file.provider.id.trim() != reference.id || file.provider.name.trim() != reference.name {
        return Err(format!(
            "Provider configuration {} does not match the root manifest.",
            reference.id
        ));
    }
    let provider_type = transport_type(&file.provider.transport)?;
    let chat_completions_path = validate_route_path(
        file.provider.routes.chat_completions,
        "Provider chat completions route",
    )?;
    let models_path = validate_route_path(file.provider.routes.models, "Provider models route")?;
    if provider_type == "openai_compatible"
        && (chat_completions_path.is_none() || models_path.is_none())
    {
        return Err(format!(
            "Provider configuration {} must declare its chat and model routes.",
            reference.id
        ));
    }
    if file.provider.auth.mode != "none"
        && (file.provider.auth.mode != "api_key"
            || file.provider.auth.location.as_deref() != Some("header")
            || file
                .provider
                .auth
                .name
                .as_deref()
                .is_none_or(|name| name.trim().is_empty()))
    {
        return Err(format!(
            "Provider configuration {} has unsupported authentication settings.",
            reference.id
        ));
    }
    if !matches!(
        file.provider.model_catalog.mode.as_str(),
        "fixed" | "provider_api"
    ) {
        return Err(format!(
            "Provider configuration {} has an unsupported model catalog mode.",
            reference.id
        ));
    }
    let headers = repository::normalize_headers(file.provider.headers)?;
    let mut setup_ids = HashSet::new();
    for field in &file.provider.setup_fields {
        if field.id.trim().is_empty()
            || field.label.trim().is_empty()
            || !setup_ids.insert(field.id.clone())
            || !field
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(format!(
                "Provider configuration {} has an invalid setup field.",
                reference.id
            ));
        }
    }
    let mut sample_endpoint = file.provider.endpoint.clone();
    for field in &file.provider.setup_fields {
        sample_endpoint = sample_endpoint.replace(&format!("{{{{{}}}}}", field.id), "value");
    }
    if sample_endpoint.contains("{{") || sample_endpoint.contains("}}") {
        return Err(format!(
            "Provider configuration {} has an unknown endpoint placeholder.",
            reference.id
        ));
    }
    repository::validate_endpoint(&sample_endpoint)?;

    let mut model_ids = HashSet::new();
    let mut models = Vec::with_capacity(file.models.len());
    for model in file.models {
        let model_id = model.model_id.trim().to_string();
        if model_id.is_empty() || !model_ids.insert(model_id.clone()) {
            return Err(format!(
                "Provider configuration {} has an invalid or duplicate model ID.",
                reference.id
            ));
        }
        let reasoning = match model.reasoning_ref {
            Some(reasoning_ref) => {
                let recipe = file
                    .reasoning_recipes
                    .get(&reasoning_ref)
                    .cloned()
                    .ok_or_else(|| {
                        format!(
                            "Provider configuration {} references an unknown reasoning recipe.",
                            reference.id
                        )
                    })?;
                validate_reasoning_config(Some(recipe))?
            }
            None => None,
        };
        let mut capabilities = model
            .capabilities
            .into_iter()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| matches!(value.as_str(), "text" | "image" | "audio" | "video"))
            .collect::<Vec<_>>();
        capabilities.sort();
        capabilities.dedup();
        if !capabilities.iter().any(|value| value == "text") {
            capabilities.insert(0, "text".to_string());
        }
        models.push(ProviderModelRecord {
            capabilities,
            display_name: model.display_name.and_then(|value| {
                let value = value.trim().to_string();
                (!value.is_empty()).then_some(value)
            }),
            max_context: model.max_context.filter(|value| *value > 0),
            max_output_tokens: model.max_output_tokens.filter(|value| *value > 0),
            model_id,
            reasoning,
            reasoning_levels: Vec::new(),
        });
    }
    if models.is_empty() {
        return Err(format!(
            "Provider configuration {} must contain at least one model.",
            reference.id
        ));
    }

    Ok(ManagedProviderDefinition {
        api_key_required: file.provider.auth.mode != "none" && file.provider.auth.required,
        auth_header_name: (file.provider.auth.mode != "none")
            .then(|| file.provider.auth.name.map(|name| name.trim().to_string()))
            .flatten(),
        auth_header_prefix: file.provider.auth.prefix,
        chat_completions_path,
        config_id: reference.id.clone(),
        default_max_context: file
            .provider
            .defaults
            .max_context
            .filter(|value| *value > 0),
        default_max_output_tokens: file
            .provider
            .defaults
            .max_output_tokens
            .filter(|value| *value > 0),
        default_model_id: file.provider.defaults.model_id,
        endpoint_template: file.provider.endpoint,
        headers,
        model_catalog_mode: file.provider.model_catalog.mode,
        models_path,
        models,
        name: reference.name.clone(),
        provider_type,
        setup_fields: file.provider.setup_fields,
    })
}

async fn download_remote_config(source_url: &str) -> Result<LoadedRemoteConfig, String> {
    let source_url = validate_https_url(source_url, "Wizzle config URL")?.to_string();
    let client = config_client()?;
    let manifest_text = fetch_text(
        &client,
        &source_url,
        APP_CONFIG_MAX_BYTES,
        "Wizzle app configuration",
    )
    .await?;
    let mut manifest = serde_yaml::from_str::<AppConfigManifest>(&manifest_text)
        .map_err(|_| "Wizzle app configuration could not be parsed.".to_string())?;
    if manifest.schema_version != 1 {
        return Err("Wizzle app configuration uses an unsupported schema version.".to_string());
    }
    manifest.revision = manifest.revision.trim().to_string();
    if manifest.revision.is_empty() {
        return Err("Wizzle app configuration revision is required.".to_string());
    }
    validate_developer(&mut manifest.developer)?;
    let update = validate_update(&mut manifest.update)?;
    for prompt in REQUIRED_PROMPTS {
        if !manifest.prompts.contains_key(*prompt) {
            return Err(format!(
                "Wizzle app configuration is missing the {prompt} prompt."
            ));
        }
    }
    if manifest.providers.is_empty() {
        return Err("Wizzle app configuration has no managed providers.".to_string());
    }
    let mut provider_ids = HashSet::new();
    for provider in &manifest.providers {
        validate_https_url(&provider.config_url, "Provider config URL")?;
        if provider.id.trim().is_empty()
            || provider.name.trim().is_empty()
            || !provider_ids.insert(provider.id.clone())
        {
            return Err("Wizzle app configuration has invalid provider entries.".to_string());
        }
    }

    let prompt_downloads = manifest.prompts.iter().map(|(id, reference)| {
        let client = &client;
        async move {
            let text = fetch_text(
                client,
                &reference.url,
                PROMPT_MAX_BYTES,
                &format!("{id} prompt"),
            )
            .await?;
            verify_hash(&text, &reference.sha256, &format!("{id} prompt"))?;
            let text = text.trim().to_string();
            if text.is_empty() {
                return Err(format!("{id} prompt is empty."));
            }
            Ok::<_, String>((id.clone(), text))
        }
    });
    let prompts = join_all(prompt_downloads)
        .await
        .into_iter()
        .collect::<Result<BTreeMap<_, _>, _>>()?;

    let provider_downloads = manifest.providers.iter().map(|reference| {
        let client = &client;
        async move {
            let text = fetch_text(
                client,
                &reference.config_url,
                PROVIDER_CONFIG_MAX_BYTES,
                &format!("{} provider configuration", reference.name),
            )
            .await?;
            verify_hash(
                &text,
                &reference.sha256,
                &format!("{} provider configuration", reference.name),
            )?;
            parse_provider_config(reference, &text)
        }
    });
    let providers = join_all(provider_downloads)
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;

    Ok(LoadedRemoteConfig {
        developer: manifest.developer,
        prompts,
        providers,
        revision: manifest.revision,
        source_url,
        update,
    })
}

fn cache_path() -> Result<std::path::PathBuf, String> {
    let root = wizzle_root_dir()?;
    let state = state_dir(&root);
    ensure_dir(&state)?;
    Ok(state.join(CACHE_FILE_NAME))
}

fn read_cached_config(source_url: &str) -> Result<LoadedRemoteConfig, String> {
    let path = cache_path()?;
    let text = fs::read_to_string(path)
        .map_err(|_| "No validated remote configuration cache is available.".to_string())?;
    let cached = serde_json::from_str::<LoadedRemoteConfig>(&text)
        .map_err(|_| "The remote configuration cache is invalid.".to_string())?;
    if cached.source_url != source_url {
        return Err("The remote configuration cache belongs to another URL.".to_string());
    }
    if cached.providers.is_empty()
        || REQUIRED_PROMPTS
            .iter()
            .any(|prompt| !cached.prompts.contains_key(*prompt))
    {
        return Err("The remote configuration cache is incomplete.".to_string());
    }
    Ok(cached)
}

fn write_cached_config(config: &LoadedRemoteConfig) {
    let result = cache_path().and_then(|path| write_json(&path, config));
    if let Err(error) = result {
        log_desktop_event(
            "warn",
            "desktop.remote-config",
            "cache_write_failed",
            serde_json::json!({ "error": error }),
        );
    }
}

#[tauri::command]
pub async fn load_remote_config(
    state: State<'_, RemoteConfigState>,
    input: LoadRemoteConfigInput,
) -> Result<RemoteConfigPayload, String> {
    let source_url = validate_https_url(&input.url, "Wizzle config URL")?.to_string();
    let (loaded, using_cache) = match download_remote_config(&source_url).await {
        Ok(loaded) => {
            write_cached_config(&loaded);
            (loaded, false)
        }
        Err(download_error) => match read_cached_config(&source_url) {
            Ok(cached) => {
                log_desktop_event(
                    "warn",
                    "desktop.remote-config",
                    "using_cached_config",
                    serde_json::json!({ "error": download_error }),
                );
                (cached, true)
            }
            Err(cache_error) => {
                return Err(format!(
                    "{download_error} {cache_error} Check your connection and retry."
                ))
            }
        },
    };
    repository::sync_managed_catalog(&loaded.providers)?;
    let payload = loaded.payload(using_cache);
    *state
        .loaded
        .lock()
        .map_err(|_| "Could not store the remote configuration.".to_string())? = Some(loaded);
    Ok(payload)
}

#[tauri::command]
pub fn setup_managed_provider(
    state: State<'_, RemoteConfigState>,
    input: SetupManagedProviderInput,
) -> Result<String, String> {
    let loaded = state
        .loaded
        .lock()
        .map_err(|_| "Could not access the remote configuration.".to_string())?;
    let loaded = loaded.as_ref().ok_or_else(|| {
        "Remote configuration is not loaded. Restart or retry startup.".to_string()
    })?;
    let definition = loaded
        .providers
        .iter()
        .find(|provider| provider.config_id == input.provider_config_id)
        .ok_or_else(|| "Managed provider is no longer listed in the remote config.".to_string())?;
    repository::setup_managed_provider(definition, input)
}

#[tauri::command]
pub fn update_managed_provider_api_key(
    input: UpdateManagedProviderApiKeyInput,
) -> Result<(), String> {
    repository::update_managed_provider_api_key(input)
}

#[cfg(test)]
mod tests {
    use super::{
        current_update_platform, download_remote_config, parse_provider_config, validate_update,
        RemoteProviderReference, RemoteUpdateManifest,
    };

    #[test]
    fn update_config_selects_the_current_platform_url() {
        let mut manifest = serde_yaml::from_str::<RemoteUpdateManifest>(
            r#"
version: 2.1.0
status: critical
note: Required security update
platforms:
  macos: { url: https://example.test/macos.json }
  windows: { url: https://example.test/windows.json }
  linux: { url: https://example.test/linux.json }
"#,
        )
        .expect("update manifest");
        let update = validate_update(&mut manifest).expect("valid update");

        assert_eq!(update.platform, current_update_platform());
        assert_eq!(
            update.url,
            format!("https://example.test/{}.json", current_update_platform())
        );
    }

    #[test]
    fn update_config_rejects_non_semantic_versions() {
        let mut manifest = serde_yaml::from_str::<RemoteUpdateManifest>(
            r#"
version: latest
url: https://example.test/latest.json
status: normal
note: Invalid release
"#,
        )
        .expect("update manifest");

        assert!(validate_update(&mut manifest).is_err());
    }

    #[test]
    fn provider_config_attaches_only_declared_reasoning() {
        let reference = RemoteProviderReference {
            id: "example".into(),
            name: "Example".into(),
            config_url: "https://example.test/provider.yaml".into(),
            sha256: "0".repeat(64),
        };
        let parsed = parse_provider_config(
            &reference,
            r#"
schemaVersion: 1
provider:
  id: example
  name: Example
  transport: openai_chat_completions
  endpoint: https://api.example.test/v1
  routes: { chatCompletions: /chat/completions, models: /models }
  auth: { mode: none }
  setupFields: []
  defaults: { modelId: plain, maxContext: 128000, maxOutputTokens: 8192 }
  modelCatalog: { mode: fixed }
  headers: []
reasoningRecipes:
  effort:
    defaultVariantId: default
    variants:
      - { id: default, label: Default, request: [] }
      - { id: high, label: High, request: [{ operation: set, path: /reasoning_effort, value: high }] }
models:
  - { modelId: plain, capabilities: [text], maxContext: 128000 }
  - { modelId: reasoning, capabilities: [text], maxContext: 128000, reasoningRef: effort }
"#,
        )
        .expect("provider config");
        assert!(parsed.models[0].reasoning.is_none());
        assert!(parsed.models[1].reasoning.is_some());
    }

    #[tokio::test]
    #[ignore = "requires the configured public remote catalog"]
    async fn configured_remote_catalog_is_valid() {
        let url = std::env::var("WIZZLE_CONFIG_URL").expect("WIZZLE_CONFIG_URL");
        let config = download_remote_config(&url).await.expect("remote config");

        assert!(!config.developer.name.is_empty());
        assert!(config.providers.len() >= 20);
        assert_eq!(config.prompts.len(), super::REQUIRED_PROMPTS.len());
    }
}
