mod anthropic;
mod crypto;
mod google;
mod native_transport;
mod openai_compatible;
pub(crate) mod reasoning;
pub(crate) mod repository;
mod retry;
pub(crate) mod types;

use futures_util::future::{AbortHandle, Abortable, Aborted};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex};
use tauri::{State, Window};
use uuid::Uuid;

use crate::agent::{AgentRuntimeState, SessionRuntimeStateKind};
use crate::logging::log_desktop_event;
use reasoning::ProviderReasoningSelection;
use types::ProviderResolvedModel;

pub use types::{
    CancelProviderChatInput, DeleteProviderInput, ProviderChatCompletionInput,
    ProviderChatStreamInput, ProviderModelPayload, ProviderPayload, RefreshProviderModelsInput,
    UpsertProviderInput,
};

const INTERRUPTED_ERROR: &str = "__WIZZLE_PROVIDER_CHAT_INTERRUPTED__";

fn resolved_reasoning_selection(
    selection: Option<ProviderReasoningSelection>,
    legacy_level: Option<String>,
) -> Option<ProviderReasoningSelection> {
    selection.or_else(|| {
        legacy_level.map(|variant_id| ProviderReasoningSelection {
            variant_id,
            ..ProviderReasoningSelection::default()
        })
    })
}

async fn dispatch_completion(
    client: &reqwest::Client,
    window: &Window,
    request_id: &str,
    model: &ProviderResolvedModel,
    body: Value,
    reasoning_selection: Option<&ProviderReasoningSelection>,
) -> Result<String, String> {
    match model.provider.provider_type.as_str() {
        "anthropic" => {
            anthropic::complete_chat(client, window, request_id, model, body, reasoning_selection)
                .await
        }
        "google" => {
            google::complete_chat(client, window, request_id, model, body, reasoning_selection)
                .await
        }
        "openai" | "openai_compatible" | "custom_openai_compatible" => {
            openai_compatible::complete_chat(
                client,
                window,
                request_id,
                model,
                body,
                reasoning_selection,
            )
            .await
        }
        _ => Err("This provider type is not supported.".to_string()),
    }
}

async fn dispatch_stream(
    client: &reqwest::Client,
    window: Window,
    request_id: &str,
    model: &ProviderResolvedModel,
    body: Value,
    reasoning_selection: Option<&ProviderReasoningSelection>,
) -> Result<(), String> {
    match model.provider.provider_type.as_str() {
        "anthropic" => {
            anthropic::stream_chat(client, window, request_id, model, body, reasoning_selection)
                .await
        }
        "google" => {
            google::stream_chat(client, window, request_id, model, body, reasoning_selection).await
        }
        "openai" | "openai_compatible" | "custom_openai_compatible" => {
            openai_compatible::stream_chat(
                client,
                window,
                request_id,
                model,
                body,
                reasoning_selection,
            )
            .await
        }
        _ => Err("This provider type is not supported.".to_string()),
    }
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
    remote_config: State<'_, crate::remote_config::RemoteConfigState>,
    input: RefreshProviderModelsInput,
) -> Result<Vec<ProviderModelPayload>, String> {
    let definition = match repository::managed_config_id(&input.provider_id)? {
        Some(config_id) => remote_config.managed_provider(&config_id)?,
        None => None,
    };
    repository::refresh_provider_models(input, definition.as_ref()).await
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

    let reasoning_selection =
        resolved_reasoning_selection(input.reasoning_selection, input.reasoning_level);
    let request_id = input
        .request_id
        .clone()
        .unwrap_or_else(|| format!("completion-{}", Uuid::new_v4()));
    let resolved_model = repository::resolve_model(&input.model_uuid)?;
    let client = openai_compatible::completion_client()?;
    let (abort_handle, abort_registration) = AbortHandle::new_pair();

    request_store.insert(request_id.clone(), abort_handle.clone())?;
    runtime.register_provider_request(&input.chat_id, &request_id, abort_handle)?;
    // Helpers (title, compaction) pass manage_session_runtime=false so they never
    // flip Idle while the agent run still owns the session (#31/#32/#61).
    if input.manage_session_runtime && !runtime.is_session_run_active(&input.chat_id) {
        let _ = runtime.set_state(&window, &input.chat_id, SessionRuntimeStateKind::Busy, None);
    }

    let completion_result = Abortable::new(
        dispatch_completion(
            &client,
            &window,
            &request_id,
            &resolved_model,
            input.body,
            reasoning_selection.as_ref(),
        ),
        abort_registration,
    )
    .await;

    let _ = request_store.remove(&request_id);
    runtime.clear_provider_request(&request_id);

    let result = match completion_result {
        Ok(result) => {
            if input.manage_session_runtime {
                let _ = runtime.release_provider_session_runtime(&window, &input.chat_id, false);
            }
            result
        }
        Err(Aborted) => {
            if input.manage_session_runtime {
                let _ = runtime.release_provider_session_runtime(&window, &input.chat_id, true);
            }
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
    let reasoning_selection =
        resolved_reasoning_selection(input.reasoning_selection, input.reasoning_level);
    let request_id = input.request_id.clone();
    let resolved_model = repository::resolve_model(&input.model_uuid)?;
    let client = openai_compatible::stream_client()?;
    let (abort_handle, abort_registration) = AbortHandle::new_pair();

    request_store.insert(request_id.clone(), abort_handle.clone())?;
    runtime.register_provider_request(&input.chat_id, &request_id, abort_handle)?;
    // Stream steps run inside an agent turn: begin_session_run already set Busy.
    // Only mark Busy when there is no active run (standalone streams).
    if !runtime.is_session_run_active(&input.chat_id) {
        let _ = runtime.set_state(&window, &input.chat_id, SessionRuntimeStateKind::Busy, None);
    }

    let stream_result = Abortable::new(
        dispatch_stream(
            &client,
            window.clone(),
            &request_id,
            &resolved_model,
            input.body,
            reasoning_selection.as_ref(),
        ),
        abort_registration,
    )
    .await;

    let _ = request_store.remove(&request_id);
    runtime.clear_provider_request(&request_id);

    match stream_result {
        Ok(result) => {
            // Never Idle while the session run is still open (tools / next steps).
            let _ = runtime.release_provider_session_runtime(&window, &input.chat_id, false);
            if result.is_ok() {
                repository::mark_model_used(&resolved_model.model_uuid)?;
            }
            result
        }
        Err(Aborted) => {
            let _ = runtime.release_provider_session_runtime(&window, &input.chat_id, true);
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
