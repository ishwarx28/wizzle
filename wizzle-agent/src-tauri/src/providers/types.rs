use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelDefinitionInput {
    pub capabilities: Option<Vec<String>>,
    pub display_name: Option<String>,
    pub max_context: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub model_id: String,
    pub reasoning_levels: Option<Vec<String>>,
    pub tokenizer_kind: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertProviderInput {
    pub api_key: Option<String>,
    pub default_model_id: Option<String>,
    pub endpoint: String,
    pub id: Option<String>,
    pub models: Option<Vec<ProviderModelDefinitionInput>>,
    pub name: String,
    pub only_specified_models: Option<bool>,
    pub provider_type: String,
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
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProviderYamlInput {
    pub yaml: String,
    pub source: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPayload {
    pub created_at_ms: u64,
    pub default_model_id: Option<String>,
    pub endpoint: String,
    pub has_api_key: bool,
    pub id: String,
    pub model_count: u64,
    pub name: String,
    pub provider_type: String,
    pub updated_at_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelPayload {
    pub capabilities: Vec<String>,
    pub display_name: Option<String>,
    pub id: String,
    pub is_pinned: bool,
    pub last_used_at_ms: Option<u64>,
    pub max_context: u64,
    pub max_output_tokens: Option<u64>,
    pub model_id: String,
    pub provider_id: String,
    pub provider_name: String,
    pub provider_type: String,
    pub reasoning_levels: Vec<String>,
    pub tokenizer_kind: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderChatStreamInput {
    pub body: Value,
    pub chat_id: String,
    pub model_uuid: String,
    pub project_id: String,
    pub reasoning_level: Option<String>,
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
    pub request_id: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelProviderChatInput {
    pub request_id: String,
}

#[derive(Clone)]
pub struct ProviderSecretRecord {
    pub api_key: Option<String>,
    pub endpoint: String,
    pub id: String,
    pub name: String,
    pub provider_type: String,
}

#[derive(Clone)]
pub struct ProviderModelRecord {
    pub capabilities: Vec<String>,
    pub display_name: Option<String>,
    pub max_context: u64,
    pub max_output_tokens: Option<u64>,
    pub model_id: String,
    pub reasoning_levels: Vec<String>,
    pub tokenizer_kind: Option<String>,
}

#[derive(Clone)]
pub struct ProviderResolvedModel {
    pub model: ProviderModelRecord,
    pub model_uuid: String,
    pub provider: ProviderSecretRecord,
}
