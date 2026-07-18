use std::{
    collections::{HashMap, HashSet},
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use futures_util::future::AbortHandle;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Window};
use tokio::sync::Mutex as AsyncMutex;

use crate::workspace::sqlite_repository;

#[cfg(target_os = "windows")]
use super::process_command::hide_tokio_console;

const SESSION_RUNTIME_STATE_EVENT: &str = "session-runtime-state";
const AGENT_PROCESS_EVENT: &str = "agent-process-updated";
const DELETE_WAIT_ATTEMPTS: usize = 120;
const DELETE_WAIT_INTERVAL_MS: u64 = 25;

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionRuntimeStateKind {
    Idle,
    Busy,
    Compacting,
    WaitingApproval,
    Interrupted,
    Error,
}

impl SessionRuntimeStateKind {
    #[cfg(test)]
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Busy => "busy",
            Self::Compacting => "compacting",
            Self::WaitingApproval => "waiting_approval",
            Self::Interrupted => "interrupted",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRuntimeStatePayload {
    pub error: Option<String>,
    pub session_id: String,
    pub state: SessionRuntimeStateKind,
    pub updated_at_ms: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRuntimeInput {
    pub session_id: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSessionRuntimeStateInput {
    pub session_id: String,
    pub state: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProcessInput {
    pub process_id: String,
    pub session_id: String,
}

#[derive(Clone, Debug)]
struct RuntimeEntry {
    error: Option<String>,
    state: SessionRuntimeStateKind,
    updated_at_ms: u64,
}

#[derive(Default)]
struct RunSlot {
    interrupted: bool,
    running: bool,
    wake_requested: bool,
}

#[derive(Default)]
struct RunCoordinator {
    slots: Mutex<HashMap<String, RunSlot>>,
}

impl RunCoordinator {
    fn begin(&self, key: &str) -> Result<(), String> {
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| "Could not access the session run coordinator.".to_string())?;
        let slot = slots.entry(key.to_string()).or_default();

        if slot.running {
            slot.wake_requested = true;
            return Err("That session already has an active run.".to_string());
        }

        slot.running = true;
        slot.interrupted = false;
        Ok(())
    }

    fn finish(&self, key: &str) -> bool {
        let Ok(mut slots) = self.slots.lock() else {
            return false;
        };
        let Some(slot) = slots.get_mut(key) else {
            return false;
        };
        let should_wake = slot.wake_requested && !slot.interrupted;
        slot.running = false;
        slot.wake_requested = false;

        if !should_wake && !slot.interrupted {
            slots.remove(key);
        }

        should_wake
    }

    fn wake(&self, key: &str) {
        if let Ok(mut slots) = self.slots.lock() {
            let slot = slots.entry(key.to_string()).or_default();
            slot.wake_requested = true;
        }
    }

    fn interrupt(&self, key: &str) {
        if let Ok(mut slots) = self.slots.lock() {
            let slot = slots.entry(key.to_string()).or_default();
            slot.interrupted = true;
            slot.wake_requested = false;
        }
    }

    fn is_running(&self, key: &str) -> bool {
        self.slots
            .lock()
            .ok()
            .and_then(|slots| slots.get(key).map(|slot| slot.running))
            .unwrap_or(false)
    }
}

#[derive(Clone)]
struct ProcessHandle {
    pid: u32,
    session_id: String,
}

#[derive(Default)]
struct AgentRuntimeInner {
    active_background_processes: Mutex<HashMap<String, ProcessHandle>>,
    active_foreground_processes: Mutex<HashMap<String, u32>>,
    active_provider_requests: Mutex<HashMap<String, HashMap<String, AbortHandle>>>,
    background_process_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    coordinator: RunCoordinator,
    foreground_shell_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    provider_request_sessions: Mutex<HashMap<String, String>>,
    runtime_states: Mutex<HashMap<String, RuntimeEntry>>,
    session_write_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    verification_baselines: Mutex<HashMap<String, HashSet<String>>>,
    write_path_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

#[derive(Clone, Default)]
pub struct AgentRuntimeState {
    inner: Arc<AgentRuntimeInner>,
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_lock_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn lock_for_key(
    locks: &Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    key: &str,
    context: &str,
) -> Result<Arc<AsyncMutex<()>>, String> {
    let mut locks = locks
        .lock()
        .map_err(|_| format!("Could not access the {context} lock map."))?;

    Ok(locks
        .entry(key.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone())
}

/// Stop a background shell and its children (e.g. `sh -c "python -m http.server"`).
/// Unix: kill process group first, then children by parent, then the pid itself.
pub(crate) async fn terminate_pid(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut command = tokio::process::Command::new("taskkill");
        hide_tokio_console(&mut command);
        let status = command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .await
            .map_err(|error| format!("Could not stop process {pid}: {error}"))?;
        if !status.success() {
            return Err(format!("Could not stop process {pid} (taskkill failed)."));
        }
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Negative PID = process group (requires spawn with process_group(0)).
        let _ = tokio::process::Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        let _ = tokio::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        // Children of the shell that left the group (common for pipelines).
        let _ = tokio::process::Command::new("pkill")
            .args(["-TERM", "-P", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;

        tokio::time::sleep(std::time::Duration::from_millis(300)).await;

        let _ = tokio::process::Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        let _ = tokio::process::Command::new("pkill")
            .args(["-KILL", "-P", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        let _ = tokio::process::Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
        Ok(())
    }
}

impl AgentRuntimeState {
    pub(crate) fn replace_verification_baseline(
        &self,
        key: &str,
        diagnostics: HashSet<String>,
    ) -> Result<Option<HashSet<String>>, String> {
        let mut baselines = self
            .inner
            .verification_baselines
            .lock()
            .map_err(|_| "Could not access verification baselines.".to_string())?;
        if baselines.len() >= 256 && !baselines.contains_key(key) {
            if let Some(oldest_key) = baselines.keys().next().cloned() {
                baselines.remove(&oldest_key);
            }
        }
        Ok(baselines.insert(key.to_string(), diagnostics))
    }

    pub fn background_process_lock(&self, session_id: &str) -> Result<Arc<AsyncMutex<()>>, String> {
        lock_for_key(
            &self.inner.background_process_locks,
            session_id,
            "background process",
        )
    }

    pub fn foreground_shell_lock(&self, session_id: &str) -> Result<Arc<AsyncMutex<()>>, String> {
        lock_for_key(
            &self.inner.foreground_shell_locks,
            session_id,
            "foreground shell",
        )
    }

    pub fn session_write_lock(&self, session_id: &str) -> Result<Arc<AsyncMutex<()>>, String> {
        lock_for_key(&self.inner.session_write_locks, session_id, "session write")
    }

    pub fn write_path_lock(&self, path: &Path) -> Result<Arc<AsyncMutex<()>>, String> {
        lock_for_key(
            &self.inner.write_path_locks,
            &normalize_lock_path(path),
            "write path",
        )
    }

    pub fn begin_session_run(&self, window: &Window, session_id: &str) -> Result<(), String> {
        self.inner.coordinator.begin(session_id)?;
        self.set_state(window, session_id, SessionRuntimeStateKind::Busy, None)
    }

    pub fn finish_session_run(&self, window: &Window, session_id: &str) -> Result<bool, String> {
        let should_wake = self.inner.coordinator.finish(session_id);
        let current_state = self.get_state(session_id)?.state;

        if !matches!(
            current_state,
            SessionRuntimeStateKind::Interrupted | SessionRuntimeStateKind::Error
        ) {
            self.set_state(window, session_id, SessionRuntimeStateKind::Idle, None)?;
        }

        Ok(should_wake)
    }

    pub fn wake_session_run(&self, session_id: &str) {
        self.inner.coordinator.wake(session_id);
    }

    /// True while `begin_session_run` is outstanding (agent turn still active).
    pub fn is_session_run_active(&self, session_id: &str) -> bool {
        self.inner.coordinator.is_running(session_id)
    }

    /// Release provider-owned Busy → Idle only when no agent run still owns the session.
    /// Prevents title/compaction/stream step completion from clearing Busy mid-turn (#31/#61).
    pub fn release_provider_session_runtime(
        &self,
        window: &Window,
        session_id: &str,
        interrupted: bool,
    ) -> Result<(), String> {
        if self.is_session_run_active(session_id) {
            // Agent run still owns runtime (busy / compacting / waiting_approval).
            return Ok(());
        }

        if interrupted {
            return self.set_state(
                window,
                session_id,
                SessionRuntimeStateKind::Interrupted,
                None,
            );
        }

        self.set_state(window, session_id, SessionRuntimeStateKind::Idle, None)
    }

    pub fn set_state(
        &self,
        window: &Window,
        session_id: &str,
        state: SessionRuntimeStateKind,
        error: Option<String>,
    ) -> Result<(), String> {
        let payload = {
            let mut states = self
                .inner
                .runtime_states
                .lock()
                .map_err(|_| "Could not update the session runtime state.".to_string())?;
            let updated_at_ms = now_unix_ms();

            if state == SessionRuntimeStateKind::Idle {
                states.remove(session_id);
                SessionRuntimeStatePayload {
                    error: None,
                    session_id: session_id.to_string(),
                    state,
                    updated_at_ms,
                }
            } else {
                let entry = RuntimeEntry {
                    error,
                    state,
                    updated_at_ms,
                };
                states.insert(session_id.to_string(), entry.clone());
                SessionRuntimeStatePayload {
                    error: entry.error,
                    session_id: session_id.to_string(),
                    state: entry.state,
                    updated_at_ms,
                }
            }
        };

        let _ = window.emit(SESSION_RUNTIME_STATE_EVENT, payload);
        Ok(())
    }

    pub fn get_state(&self, session_id: &str) -> Result<SessionRuntimeStatePayload, String> {
        let states = self
            .inner
            .runtime_states
            .lock()
            .map_err(|_| "Could not read the session runtime state.".to_string())?;

        if let Some(entry) = states.get(session_id) {
            return Ok(SessionRuntimeStatePayload {
                error: entry.error.clone(),
                session_id: session_id.to_string(),
                state: entry.state,
                updated_at_ms: entry.updated_at_ms,
            });
        }

        Ok(SessionRuntimeStatePayload {
            error: None,
            session_id: session_id.to_string(),
            state: SessionRuntimeStateKind::Idle,
            updated_at_ms: now_unix_ms(),
        })
    }

    pub fn list_states(&self) -> Result<Vec<SessionRuntimeStatePayload>, String> {
        let states = self
            .inner
            .runtime_states
            .lock()
            .map_err(|_| "Could not list session runtime states.".to_string())?;

        Ok(states
            .iter()
            .map(|(session_id, entry)| SessionRuntimeStatePayload {
                error: entry.error.clone(),
                session_id: session_id.clone(),
                state: entry.state,
                updated_at_ms: entry.updated_at_ms,
            })
            .collect())
    }

    pub fn is_interrupted(&self, session_id: &str) -> bool {
        self.get_state(session_id)
            .map(|payload| payload.state == SessionRuntimeStateKind::Interrupted)
            .unwrap_or(false)
    }

    pub fn register_provider_request(
        &self,
        session_id: &str,
        request_id: &str,
        abort_handle: AbortHandle,
    ) -> Result<(), String> {
        self.inner
            .provider_request_sessions
            .lock()
            .map_err(|_| "Could not track provider request ownership.".to_string())?
            .insert(request_id.to_string(), session_id.to_string());

        self.inner
            .active_provider_requests
            .lock()
            .map_err(|_| "Could not track provider requests.".to_string())?
            .entry(session_id.to_string())
            .or_default()
            .insert(request_id.to_string(), abort_handle);

        Ok(())
    }

    pub fn clear_provider_request(&self, request_id: &str) {
        let session_id = self
            .inner
            .provider_request_sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(request_id));

        let Some(session_id) = session_id else {
            return;
        };

        if let Ok(mut active_requests) = self.inner.active_provider_requests.lock() {
            if let Some(session_requests) = active_requests.get_mut(&session_id) {
                session_requests.remove(request_id);

                if session_requests.is_empty() {
                    active_requests.remove(&session_id);
                }
            }
        }
    }

    pub fn abort_provider_request_by_id(&self, request_id: &str) {
        let abort_handle = {
            let session_id = self
                .inner
                .provider_request_sessions
                .lock()
                .ok()
                .and_then(|sessions| sessions.get(request_id).cloned());
            let Some(session_id) = session_id else {
                return;
            };
            self.inner
                .active_provider_requests
                .lock()
                .ok()
                .and_then(|active| {
                    active
                        .get(&session_id)
                        .and_then(|requests| requests.get(request_id).cloned())
                })
        };

        if let Some(abort_handle) = abort_handle {
            abort_handle.abort();
        }
    }

    pub fn register_foreground_process(&self, session_id: &str, pid: u32) -> Result<(), String> {
        self.inner
            .active_foreground_processes
            .lock()
            .map_err(|_| "Could not track the active shell process.".to_string())?
            .insert(session_id.to_string(), pid);
        Ok(())
    }

    pub fn unregister_foreground_process(&self, session_id: &str, pid: u32) {
        if let Ok(mut processes) = self.inner.active_foreground_processes.lock() {
            if processes.get(session_id).copied() == Some(pid) {
                processes.remove(session_id);
            }
        }
    }

    pub fn register_background_process(
        &self,
        session_id: &str,
        process_id: &str,
        pid: u32,
    ) -> Result<(), String> {
        self.inner
            .active_background_processes
            .lock()
            .map_err(|_| "Could not track the background process.".to_string())?
            .insert(
                process_id.to_string(),
                ProcessHandle {
                    pid,
                    session_id: session_id.to_string(),
                },
            );
        Ok(())
    }

    pub fn unregister_background_process(&self, process_id: &str) {
        if let Ok(mut processes) = self.inner.active_background_processes.lock() {
            processes.remove(process_id);
        }
    }

    pub async fn stop_process(
        &self,
        window: &Window,
        session_id: &str,
        process_id: &str,
    ) -> Result<sqlite_repository::WorkspaceProcessPayload, String> {
        let lock = self.background_process_lock(session_id)?;
        let _guard = lock.lock().await;
        let handle = self
            .inner
            .active_background_processes
            .lock()
            .map_err(|_| "Could not read background process state.".to_string())?
            .get(process_id)
            .cloned();

        let pid = if let Some(handle) = handle {
            if handle.session_id != session_id {
                return Err("That process belongs to a different session.".to_string());
            }
            Some(handle.pid)
        } else {
            // App restart / map miss: still kill using the SQL-tracked pid when present.
            sqlite_repository::read_process(session_id, process_id)
                .ok()
                .and_then(|process| process.pid.map(|value| value as u32))
        };

        if let Some(pid) = pid {
            terminate_pid(pid).await?;
            self.unregister_background_process(process_id);
        }

        let process = sqlite_repository::mark_process_interrupted(session_id, process_id)?;
        let _ = window.emit(AGENT_PROCESS_EVENT, process.clone());
        Ok(process)
    }

    pub async fn stop_background_processes_for_session(
        &self,
        window: &Window,
        session_id: &str,
    ) -> Result<(), String> {
        let process_ids = self.background_process_ids_for_session(session_id)?;

        for process_id in process_ids {
            let _ = self.stop_process(window, session_id, &process_id).await;
        }

        Ok(())
    }

    pub async fn interrupt_session(&self, window: &Window, session_id: &str) -> Result<(), String> {
        self.inner.coordinator.interrupt(session_id);

        let provider_abort_handles = {
            let mut active_requests = self
                .inner
                .active_provider_requests
                .lock()
                .map_err(|_| "Could not access provider request state.".to_string())?;
            active_requests
                .remove(session_id)
                .map(|requests| requests.into_values().collect::<Vec<_>>())
                .unwrap_or_default()
        };

        for abort_handle in provider_abort_handles {
            abort_handle.abort();
        }

        let foreground_pid = self
            .inner
            .active_foreground_processes
            .lock()
            .map_err(|_| "Could not access foreground process state.".to_string())?
            .get(session_id)
            .copied();

        if let Some(pid) = foreground_pid {
            terminate_pid(pid).await?;
        }

        // Background shell (dev servers, watchers) must stop on interrupt too (#36).
        let _ = self
            .stop_background_processes_for_session(window, session_id)
            .await;

        self.set_state(
            window,
            session_id,
            SessionRuntimeStateKind::Interrupted,
            None,
        )
    }

    pub async fn prepare_session_delete(
        &self,
        window: &Window,
        session_id: &str,
    ) -> Result<(), String> {
        self.interrupt_session(window, session_id).await?;
        self.stop_background_processes_for_session(window, session_id)
            .await?;

        for _ in 0..DELETE_WAIT_ATTEMPTS {
            if self.session_has_no_active_work(session_id)? {
                break;
            }

            tokio::time::sleep(std::time::Duration::from_millis(DELETE_WAIT_INTERVAL_MS)).await;
        }

        let foreground_lock = self.foreground_shell_lock(session_id)?;
        let _foreground_guard = foreground_lock.lock().await;
        let background_lock = self.background_process_lock(session_id)?;
        let _background_guard = background_lock.lock().await;
        let write_lock = self.session_write_lock(session_id)?;
        let _write_guard = write_lock.lock().await;

        Ok(())
    }

    pub fn emit_process_update(
        &self,
        window: &Window,
        process: sqlite_repository::WorkspaceProcessPayload,
    ) {
        let _ = window.emit(AGENT_PROCESS_EVENT, process);
    }

    fn background_process_ids_for_session(&self, session_id: &str) -> Result<Vec<String>, String> {
        let processes = self
            .inner
            .active_background_processes
            .lock()
            .map_err(|_| "Could not read background process state.".to_string())?;

        Ok(processes
            .iter()
            .filter_map(|(process_id, handle)| {
                (handle.session_id == session_id).then_some(process_id.clone())
            })
            .collect())
    }

    fn session_has_no_active_work(&self, session_id: &str) -> Result<bool, String> {
        let has_provider_requests = self
            .inner
            .active_provider_requests
            .lock()
            .map_err(|_| "Could not read provider request state.".to_string())?
            .get(session_id)
            .map(|requests| !requests.is_empty())
            .unwrap_or(false);
        let has_foreground_process = self
            .inner
            .active_foreground_processes
            .lock()
            .map_err(|_| "Could not read foreground process state.".to_string())?
            .contains_key(session_id);
        let has_background_process = self
            .inner
            .active_background_processes
            .lock()
            .map_err(|_| "Could not read background process state.".to_string())?
            .values()
            .any(|handle| handle.session_id == session_id);

        Ok(!has_provider_requests && !has_foreground_process && !has_background_process)
    }
}

#[tauri::command]
pub fn get_session_runtime_state(
    input: SessionRuntimeInput,
    runtime: tauri::State<'_, AgentRuntimeState>,
) -> Result<SessionRuntimeStatePayload, String> {
    runtime.get_state(&input.session_id)
}

#[tauri::command]
pub fn set_session_runtime_state(
    window: Window,
    input: SetSessionRuntimeStateInput,
    runtime: tauri::State<'_, AgentRuntimeState>,
) -> Result<SessionRuntimeStatePayload, String> {
    let state = match input.state.as_str() {
        "idle" => SessionRuntimeStateKind::Idle,
        "busy" => SessionRuntimeStateKind::Busy,
        "compacting" => SessionRuntimeStateKind::Compacting,
        "waiting_approval" => SessionRuntimeStateKind::WaitingApproval,
        "interrupted" => SessionRuntimeStateKind::Interrupted,
        "error" => SessionRuntimeStateKind::Error,
        _ => {
            return Err(format!(
                "Unsupported session runtime state: {}",
                input.state
            ))
        }
    };

    runtime.set_state(&window, &input.session_id, state, None)?;
    runtime.get_state(&input.session_id)
}

#[tauri::command]
pub fn list_session_runtime_states(
    runtime: tauri::State<'_, AgentRuntimeState>,
) -> Result<Vec<SessionRuntimeStatePayload>, String> {
    runtime.list_states()
}

#[tauri::command]
pub fn wake_session_run(
    input: SessionRuntimeInput,
    runtime: tauri::State<'_, AgentRuntimeState>,
) -> Result<(), String> {
    runtime.wake_session_run(&input.session_id);
    Ok(())
}

#[tauri::command]
pub fn begin_session_run(
    window: Window,
    input: SessionRuntimeInput,
    runtime: tauri::State<'_, AgentRuntimeState>,
) -> Result<(), String> {
    runtime.begin_session_run(&window, &input.session_id)
}

#[tauri::command]
pub fn finish_session_run(
    window: Window,
    input: SessionRuntimeInput,
    runtime: tauri::State<'_, AgentRuntimeState>,
) -> Result<bool, String> {
    runtime.finish_session_run(&window, &input.session_id)
}

#[tauri::command]
pub async fn interrupt_session_run(
    window: Window,
    input: SessionRuntimeInput,
    runtime: tauri::State<'_, AgentRuntimeState>,
) -> Result<(), String> {
    runtime.interrupt_session(&window, &input.session_id).await
}

#[tauri::command]
pub fn list_agent_processes(
    input: SessionRuntimeInput,
) -> Result<Vec<sqlite_repository::WorkspaceProcessPayload>, String> {
    sqlite_repository::list_processes(&input.session_id)
}

#[tauri::command]
pub fn read_agent_process(
    input: SessionProcessInput,
) -> Result<sqlite_repository::WorkspaceProcessPayload, String> {
    sqlite_repository::read_process(&input.session_id, &input.process_id)
}

#[tauri::command]
pub async fn stop_agent_process(
    window: Window,
    input: SessionProcessInput,
    runtime: tauri::State<'_, AgentRuntimeState>,
) -> Result<sqlite_repository::WorkspaceProcessPayload, String> {
    runtime
        .stop_process(&window, &input.session_id, &input.process_id)
        .await
}

#[cfg(test)]
pub fn active_runtime_state_names() -> HashSet<&'static str> {
    [
        SessionRuntimeStateKind::Idle,
        SessionRuntimeStateKind::Busy,
        SessionRuntimeStateKind::Compacting,
        SessionRuntimeStateKind::WaitingApproval,
        SessionRuntimeStateKind::Interrupted,
        SessionRuntimeStateKind::Error,
    ]
    .into_iter()
    .map(SessionRuntimeStateKind::as_str)
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_state_names_cover_phase_six_states() {
        let names = active_runtime_state_names();

        for state in [
            "idle",
            "busy",
            "compacting",
            "waiting_approval",
            "interrupted",
            "error",
        ] {
            assert!(names.contains(state), "{state} should be present");
        }
    }

    #[test]
    fn run_coordinator_coalesces_wakeups_and_interrupts() {
        let coordinator = RunCoordinator::default();

        coordinator.begin("session-1").expect("begin first run");
        coordinator.wake("session-1");
        coordinator.wake("session-1");
        assert!(coordinator.begin("session-1").is_err());
        assert!(coordinator.finish("session-1"));

        coordinator.begin("session-1").expect("begin second run");
        coordinator.wake("session-1");
        coordinator.interrupt("session-1");
        assert!(!coordinator.finish("session-1"));
    }

    #[test]
    fn run_coordinator_allows_different_sessions() {
        let coordinator = RunCoordinator::default();

        coordinator.begin("session-1").expect("begin first session");
        coordinator
            .begin("session-2")
            .expect("begin second session");
        assert!(coordinator.begin("session-1").is_err());
        assert!(!coordinator.finish("session-2"));
        assert!(coordinator.finish("session-1"));
    }
}
