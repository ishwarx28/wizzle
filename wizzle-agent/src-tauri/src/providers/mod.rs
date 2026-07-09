mod crypto;
mod openai_compatible;
mod repository;
mod types;

use futures_util::future::{AbortHandle, Abortable, Aborted};
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{State, Window};
use uuid::Uuid;

use crate::agent::{AgentRuntimeState, SessionRuntimeStateKind};
use crate::logging::log_desktop_event;
use crate::workspace::paths::{ensure_dir, wizzle_root_dir};

pub use types::{
    CancelProviderChatInput, DeleteProviderInput, ImportProviderYamlInput,
    ProviderChatCompletionInput, ProviderChatStreamInput, ProviderModelPayload, ProviderPayload,
    RefreshProviderModelsInput, UpsertProviderInput,
};

const INTERRUPTED_ERROR: &str = "__WIZZLE_PROVIDER_CHAT_INTERRUPTED__";

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn write_debug_history(body: &serde_json::Value) -> Result<(), String> {
    let root = wizzle_root_dir()?;
    ensure_dir(&root)?;
    let path = root.join("debug-history.json");
    // Temporary debugging only: this file captures the latest provider replay body and should not be treated as durable storage.
    let payload = json!({
        "body": body,
        "writtenAtMs": now_unix_ms(),
    });
    let contents = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("Could not serialize Wizzle debug history: {error}"))?;
    fs::write(&path, contents).map_err(|error| {
        format!(
            "Could not write Wizzle debug history to {}: {error}",
            path.display()
        )
    })
}

fn resolved_debug_body(
    body: &serde_json::Value,
    resolved_model: &types::ProviderResolvedModel,
    stream: bool,
    reasoning_level: Option<&str>,
) -> serde_json::Value {
    openai_compatible::build_request_body(resolved_model, body.clone(), stream, reasoning_level)
}

fn write_unresolved_debug_history(body: &serde_json::Value, error: &str) -> Result<(), String> {
    let mut body = body.clone();

    if let Some(object) = body.as_object_mut() {
        object.insert(
            "modelResolutionError".to_string(),
            serde_json::Value::String(error.to_string()),
        );
    }

    write_debug_history(&body)
}

#[derive(Default)]
pub struct ProviderChatRequestStore {
    active: Mutex<HashMap<String, AbortHandle>>,
}

impl ProviderChatRequestStore {
    fn insert(&self, request_id: String, abort_handle: AbortHandle) -> Result<(), String> {
        self.active
            .lock()
            .map_err(|_| "Could not register the active provider request.".to_string())?
            .insert(request_id, abort_handle);
        Ok(())
    }

    fn remove(&self, request_id: &str) -> Result<Option<AbortHandle>, String> {
        Ok(self
            .active
            .lock()
            .map_err(|_| "Could not access the active provider request.".to_string())?
            .remove(request_id))
    }
}

#[tauri::command]
pub fn list_providers() -> Result<Vec<ProviderPayload>, String> {
    repository::list_providers()
}

#[tauri::command]
pub fn upsert_provider(input: UpsertProviderInput) -> Result<String, String> {
    repository::upsert_provider(input)
}

#[tauri::command]
pub fn delete_provider(input: DeleteProviderInput) -> Result<(), String> {
    repository::delete_provider(&input.provider_id)
}

#[tauri::command]
pub fn list_provider_models() -> Result<Vec<ProviderModelPayload>, String> {
    repository::list_models()
}

#[tauri::command]
pub async fn refresh_provider_models(
    input: RefreshProviderModelsInput,
) -> Result<Vec<ProviderModelPayload>, String> {
    repository::refresh_provider_models(input).await
}

#[tauri::command]
pub fn import_provider_yaml(input: ImportProviderYamlInput) -> Result<(), String> {
    repository::import_provider_yaml(input)
}

#[tauri::command]
pub async fn complete_provider_chat(
    window: Window,
    request_store: State<'_, ProviderChatRequestStore>,
    runtime: State<'_, AgentRuntimeState>,
    input: ProviderChatCompletionInput,
) -> Result<String, String> {
    log_desktop_event(
        "info",
        "desktop.provider",
        "completion_started",
        json!({
            "chatIdLength": input.chat_id.len(),
            "projectIdLength": input.project_id.len(),
            "modelUuidLength": input.model_uuid.len(),
            "reasoningLevel": input.reasoning_level,
        }),
    );

    let request_id = input
        .request_id
        .clone()
        .unwrap_or_else(|| format!("completion-{}", Uuid::new_v4()));
    let resolved_model = repository::resolve_model(&input.model_uuid)?;
    let client = reqwest::Client::new();
    let (abort_handle, abort_registration) = AbortHandle::new_pair();

    request_store.insert(request_id.clone(), abort_handle.clone())?;
    runtime.register_provider_request(&input.chat_id, &request_id, abort_handle)?;
    let _ = runtime.set_state(&window, &input.chat_id, SessionRuntimeStateKind::Busy, None);

    let completion_result = Abortable::new(
        openai_compatible::complete_chat(
            &client,
            &resolved_model,
            input.body,
            input.reasoning_level.as_deref(),
        ),
        abort_registration,
    )
    .await;

    let _ = request_store.remove(&request_id);
    runtime.clear_provider_request(&request_id);

    let result = match completion_result {
        Ok(result) => {
            let _ = runtime.set_state(&window, &input.chat_id, SessionRuntimeStateKind::Idle, None);
            result
        }
        Err(Aborted) => {
            let _ = runtime.set_state(
                &window,
                &input.chat_id,
                SessionRuntimeStateKind::Interrupted,
                None,
            );
            Err(INTERRUPTED_ERROR.to_string())
        }
    };

    if result.is_ok() {
        repository::mark_model_used(&resolved_model.model_uuid)?;
    }

    result
}

#[tauri::command]
pub async fn stream_provider_chat(
    window: Window,
    request_store: State<'_, ProviderChatRequestStore>,
    runtime: State<'_, AgentRuntimeState>,
    input: ProviderChatStreamInput,
) -> Result<(), String> {
    log_desktop_event(
        "info",
        "desktop.provider",
        "stream_started",
        json!({
            "chatIdLength": input.chat_id.len(),
            "projectIdLength": input.project_id.len(),
            "modelUuidLength": input.model_uuid.len(),
            "requestIdLength": input.request_id.len(),
            "reasoningLevel": input.reasoning_level,
        }),
    );
    let request_id = input.request_id.clone();
    let resolved_model = match repository::resolve_model(&input.model_uuid) {
        Ok(model) => model,
        Err(error) => {
            let _ = write_unresolved_debug_history(&input.body, &error);
            return Err(error);
        }
    };
    let debug_body = resolved_debug_body(
        &input.body,
        &resolved_model,
        true,
        input.reasoning_level.as_deref(),
    );

    if let Err(error) = write_debug_history(&debug_body) {
        log_desktop_event(
            "warn",
            "desktop.provider",
            "debug_history_write_failed",
            json!({ "error": error }),
        );
    }

    let client = reqwest::Client::new();
    let (abort_handle, abort_registration) = AbortHandle::new_pair();

    request_store.insert(request_id.clone(), abort_handle.clone())?;
    runtime.register_provider_request(&input.chat_id, &request_id, abort_handle)?;
    let _ = runtime.set_state(&window, &input.chat_id, SessionRuntimeStateKind::Busy, None);

    let stream_result = Abortable::new(
        openai_compatible::stream_chat(
            &client,
            window.clone(),
            &request_id,
            &resolved_model,
            input.body,
            input.reasoning_level.as_deref(),
        ),
        abort_registration,
    )
    .await;

    let _ = request_store.remove(&request_id);
    runtime.clear_provider_request(&request_id);

    match stream_result {
        Ok(result) => {
            let _ = runtime.set_state(&window, &input.chat_id, SessionRuntimeStateKind::Idle, None);
            if result.is_ok() {
                repository::mark_model_used(&resolved_model.model_uuid)?;
            }
            result
        }
        Err(Aborted) => {
            let _ = runtime.set_state(
                &window,
                &input.chat_id,
                SessionRuntimeStateKind::Interrupted,
                None,
            );
            Err(INTERRUPTED_ERROR.to_string())
        }
    }
}

#[tauri::command]
pub fn cancel_provider_chat(
    request_store: State<'_, ProviderChatRequestStore>,
    runtime: State<'_, AgentRuntimeState>,
    input: CancelProviderChatInput,
) -> Result<(), String> {
    let maybe_abort_handle = request_store.remove(&input.request_id)?;
    runtime.abort_provider_request_by_id(&input.request_id);
    runtime.clear_provider_request(&input.request_id);

    if let Some(abort_handle) = maybe_abort_handle {
        abort_handle.abort();
    }

    Ok(())
}
