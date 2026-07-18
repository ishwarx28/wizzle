use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use super::reasoning::{ModelReasoningConfig, ProviderReasoningSelection};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelDefinitionInput {
    pub capabilities: Option<Vec<String>>,
    #[serde(alias = "display_name")]
    pub display_name: Option<String>,
    #[serde(alias = "max_context")]
    pub max_context: Option<u64>,
    #[serde(alias = "max_output_tokens")]
    pub max_output_tokens: Option<u64>,
    #[serde(alias = "model_id")]
    pub model_id: String,
    #[serde(default)]
    pub reasoning: Option<ModelReasoningConfig>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHeaderInput {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequestFieldInput {
    pub path: String,
    pub value: Value,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertProviderInput {
    pub api_key: Option<String>,
    pub default_max_context: Option<u64>,
    pub default_max_output_tokens: Option<u64>,
    pub default_model_id: Option<String>,
    pub endpoint: String,
    #[serde(default)]
    pub headers: Vec<ProviderHeaderInput>,
    pub id: Option<String>,
    pub models: Option<Vec<ProviderModelDefinitionInput>>,
    pub name: String,
    pub only_specified_models: Option<bool>,
    /// Treat `models` as the complete local set, deleting omitted entries.
    /// Kept separate from catalog discovery so edits never trigger network sync implicitly.
    pub replace_models: Option<bool>,
    pub provider_type: String,
    #[serde(default)]
    pub request_fields: Vec<ProviderRequestFieldInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupManagedProviderInput {
    pub api_key: Option<String>,
    pub provider_config_id: String,
    #[serde(default)]
    pub setup_values: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateManagedProviderApiKeyInput {
    pub api_key: Option<String>,
    pub provider_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProviderInput {
    pub provider_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshProviderModelsInput {
    pub provider_id: String,
    /// Upsert every model returned by the provider `/models` list.
    #[serde(default)]
    pub fetch_all: bool,
    /// Drop local models that are not present on the remote `/models` list.
    #[serde(default)]
    pub remove_invalid: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPayload {
    pub can_refresh_models: bool,
    pub created_at_ms: u64,
    pub default_max_context: Option<u64>,
    pub default_max_output_tokens: Option<u64>,
    pub default_model_id: Option<String>,
    pub endpoint: String,
    pub has_api_key: bool,
    pub headers: Vec<ProviderHeaderInput>,
    pub id: String,
    pub is_managed: bool,
    pub managed_config_id: Option<String>,
    pub model_count: u64,
    pub name: String,
    pub provider_type: String,
    pub request_fields: Vec<ProviderRequestFieldInput>,
    pub updated_at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelPayload {
    pub capabilities: Vec<String>,
    pub configured_max_context: Option<u64>,
    pub configured_max_output_tokens: Option<u64>,
    pub display_name: Option<String>,
    pub id: String,
    pub is_pinned: bool,
    pub last_used_at_ms: Option<u64>,
    pub max_context: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub model_id: String,
    pub provider_id: String,
    pub provider_name: String,
    pub provider_type: String,
    pub reasoning: Option<ModelReasoningConfig>,
    pub reasoning_levels: Vec<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderChatStreamInput {
    pub body: Value,
    pub chat_id: String,
    pub model_uuid: String,
    pub project_id: String,
    pub reasoning_level: Option<String>,
    pub reasoning_selection: Option<ProviderReasoningSelection>,
    pub request_id: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderChatCompletionInput {
    pub body: Value,
    pub chat_id: String,
    pub model_uuid: String,
    pub project_id: String,
    pub reasoning_level: Option<String>,
    pub reasoning_selection: Option<ProviderReasoningSelection>,
    pub request_id: Option<String>,
    /// When false, do not touch session runtime Busy/Idle (title, compaction helpers).
    /// Defaults to true when omitted.
    #[serde(default = "default_manage_session_runtime")]
    pub manage_session_runtime: bool,
}

fn default_manage_session_runtime() -> bool {
    true
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelProviderChatInput {
    pub request_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSecretRecord {
    pub api_key: Option<String>,
    pub api_key_required: bool,
    pub auth_header_name: Option<String>,
    pub auth_header_prefix: String,
    pub chat_completions_path: Option<String>,
    pub endpoint: String,
    pub headers: Vec<ProviderHeaderInput>,
    pub id: String,
    pub models_path: Option<String>,
    pub name: String,
    pub provider_type: String,
    pub request_fields: Vec<ProviderRequestFieldInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelRecord {
    pub capabilities: Vec<String>,
    pub display_name: Option<String>,
    pub max_context: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub model_id: String,
    pub reasoning: Option<ModelReasoningConfig>,
    pub reasoning_levels: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProviderSetupField {
    pub id: String,
    pub label: String,
    pub required: bool,
    pub secret: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProviderDefinition {
    pub api_key_required: bool,
    pub auth_header_name: Option<String>,
    pub auth_header_prefix: String,
    pub chat_completions_path: Option<String>,
    pub config_id: String,
    pub default_max_context: Option<u64>,
    pub default_max_output_tokens: Option<u64>,
    pub default_model_id: Option<String>,
    pub endpoint_template: String,
    pub headers: Vec<ProviderHeaderInput>,
    pub models: Vec<ProviderModelRecord>,
    pub model_catalog_mode: String,
    pub models_path: Option<String>,
    pub name: String,
    pub provider_type: String,
    pub setup_fields: Vec<ManagedProviderSetupField>,
}

#[derive(Clone)]
pub struct ProviderResolvedModel {
    pub model: ProviderModelRecord,
    pub model_uuid: String,
    pub provider: ProviderSecretRecord,
}
