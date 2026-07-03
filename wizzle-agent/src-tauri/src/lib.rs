use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{Emitter, State};

#[derive(Clone, Serialize)]
struct GoogleOAuthCallbackPayload {
    url: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleOAuthSessionInput {
    code_verifier: String,
    state: String,
}

#[derive(Clone, Default, Serialize)]
struct GoogleOAuthSession {
    code_verifier: String,
    redirect_uri: String,
    state: String,
}

#[derive(Default)]
struct GoogleOAuthSessionStore {
    current: Mutex<Option<GoogleOAuthSession>>,
}

fn oauth_success_response() -> &'static str {
    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><html><head><meta charset=\"utf-8\"><title>Wizzle</title><style>body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;background:#111;color:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}div{max-width:420px}h1{font-size:24px;margin:0 0 12px}p{font-size:15px;line-height:1.6;color:#b3b3b3;margin:0}</style></head><body><div><h1>Signed in to Wizzle</h1><p>You can close this browser window and return to the app.</p></div></body></html>"
}

fn oauth_error_response() -> &'static str {
    "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><html><head><meta charset=\"utf-8\"><title>Wizzle</title><style>body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;background:#111;color:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}div{max-width:420px}h1{font-size:24px;margin:0 0 12px}p{font-size:15px;line-height:1.6;color:#b3b3b3;margin:0}</style></head><body><div><h1>Sign-in could not be completed</h1><p>Return to Wizzle and try again.</p></div></body></html>"
}

fn extract_request_path(request: &str) -> Option<&str> {
    request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
}

#[tauri::command]
fn start_google_oauth_listener(
    app: tauri::AppHandle,
    store: State<'_, GoogleOAuthSessionStore>,
    session: GoogleOAuthSessionInput,
) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Could not start Google sign-in callback listener: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not resolve Google sign-in callback port: {error}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not prepare Google sign-in callback listener: {error}"))?;

    {
        let mut current = store
            .current
            .lock()
            .map_err(|_| "Could not store Google sign-in session.".to_string())?;
        *current = Some(GoogleOAuthSession {
            code_verifier: session.code_verifier,
            redirect_uri: redirect_uri.clone(),
            state: session.state,
        });
    }

    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(300);

        loop {
            if Instant::now() >= deadline {
                break;
            }

            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buffer = [0_u8; 8192];
                    let bytes_read = stream.read(&mut buffer).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..bytes_read]);

                    if let Some(path) = extract_request_path(&request) {
                        let url = format!("http://127.0.0.1:{port}{path}");
                        let response = if path.starts_with("/?") || path == "/" {
                            let _ = app.emit(
                                "google-oauth-callback",
                                GoogleOAuthCallbackPayload { url },
                            );
                            oauth_success_response()
                        } else {
                            oauth_error_response()
                        };

                        let _ = stream.write_all(response.as_bytes());
                        let _ = stream.flush();
                        break;
                    }

                    let _ = stream.write_all(oauth_error_response().as_bytes());
                    let _ = stream.flush();
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(100));
                }
                Err(_) => break,
            }
        }
    });

    Ok(redirect_uri)
}

#[tauri::command]
fn get_google_oauth_session(
    store: State<'_, GoogleOAuthSessionStore>,
) -> Result<Option<GoogleOAuthSession>, String> {
    let current = store
        .current
        .lock()
        .map_err(|_| "Could not read Google sign-in session.".to_string())?;

    Ok(current.clone())
}

#[tauri::command]
fn clear_google_oauth_session(store: State<'_, GoogleOAuthSessionStore>) -> Result<(), String> {
    let mut current = store
        .current
        .lock()
        .map_err(|_| "Could not clear Google sign-in session.".to_string())?;
    *current = None;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(GoogleOAuthSessionStore::default())
        .invoke_handler(tauri::generate_handler![
            start_google_oauth_listener,
            get_google_oauth_session,
            clear_google_oauth_session
        ])
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
