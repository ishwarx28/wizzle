use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use semver::Version;
use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

use crate::{logging::log_desktop_event, remote_config::RemoteConfigState};

const UPDATE_TIMEOUT: Duration = Duration::from_secs(120);
const UPDATER_PUBLIC_KEY: &str = match option_env!("WIZZLE_UPDATER_PUBLIC_KEY") {
    Some(key) => key,
    None => "",
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateProgress {
    phase: &'static str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

fn public_key() -> Result<String, String> {
    let key = UPDATER_PUBLIC_KEY.trim();
    if !key.is_empty() {
        return Ok(key.to_string());
    }
    #[cfg(debug_assertions)]
    if let Ok(key) = std::env::var("WIZZLE_UPDATER_PUBLIC_KEY") {
        if !key.trim().is_empty() {
            return Ok(key.trim().to_string());
        }
    }
    Err("In-app updates are not configured in this build.".to_string())
}

fn log_update_failure(event: &str, error: impl std::fmt::Display) {
    log_desktop_event(
        "error",
        "desktop.app-update",
        event,
        serde_json::json!({ "error": error.to_string() }),
    );
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: State<'_, RemoteConfigState>,
    on_event: Channel<AppUpdateProgress>,
) -> Result<(), String> {
    let configured = state.app_update()?;
    if !configured.enabled {
        return Err("In-app updates are disabled in the remote configuration.".to_string());
    }
    let current_version = app.package_info().version.clone();
    let expected_version = Version::parse(&configured.version)
        .map_err(|_| "The configured update version is invalid.".to_string())?;
    if expected_version <= current_version {
        return Err("Wizzle is already up to date.".to_string());
    }

    let endpoint = configured
        .url
        .parse()
        .map_err(|_| "The configured update URL is invalid.".to_string())?;
    let updater = app
        .updater_builder()
        .pubkey(public_key()?)
        .endpoints(vec![endpoint])
        .map_err(|error| {
            log_update_failure("updater_endpoint_failed", error);
            "Wizzle could not prepare the update service.".to_string()
        })?
        .timeout(UPDATE_TIMEOUT)
        .build()
        .map_err(|error| {
            log_update_failure("updater_build_failed", error);
            "Wizzle could not prepare the update service.".to_string()
        })?;
    let update = updater
        .check()
        .await
        .map_err(|error| {
            log_update_failure("update_check_failed", error);
            "Wizzle could not verify the available update.".to_string()
        })?
        .ok_or_else(|| "The configured update is no longer available.".to_string())?;
    if update.version != configured.version {
        log_update_failure(
            "update_version_mismatch",
            format!(
                "configuration={}, endpoint={}",
                configured.version, update.version
            ),
        );
        return Err("The update service returned an unexpected version.".to_string());
    }

    let downloaded_bytes = Arc::new(AtomicU64::new(0));
    let progress_downloaded_bytes = Arc::clone(&downloaded_bytes);
    let finish_downloaded_bytes = Arc::clone(&downloaded_bytes);
    let progress_channel = on_event.clone();
    let finish_channel = on_event.clone();
    update
        .download_and_install(
            move |chunk_length, total_bytes| {
                let downloaded_bytes = progress_downloaded_bytes
                    .fetch_add(chunk_length as u64, Ordering::Relaxed)
                    .saturating_add(chunk_length as u64);
                let _ = progress_channel.send(AppUpdateProgress {
                    phase: "downloading",
                    downloaded_bytes,
                    total_bytes,
                });
            },
            move || {
                let _ = finish_channel.send(AppUpdateProgress {
                    phase: "installing",
                    downloaded_bytes: finish_downloaded_bytes.load(Ordering::Relaxed),
                    total_bytes: None,
                });
            },
        )
        .await
        .map_err(|error| {
            log_update_failure("update_install_failed", error);
            "Wizzle could not download or install the update.".to_string()
        })?;

    let _ = on_event.send(AppUpdateProgress {
        phase: "restarting",
        downloaded_bytes: downloaded_bytes.load(Ordering::Relaxed),
        total_bytes: None,
    });
    app.restart();
}
