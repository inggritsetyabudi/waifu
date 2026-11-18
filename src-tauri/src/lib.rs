mod nim;
#[cfg(test)]
mod nim_test;
mod recognition;
mod settings;
mod speech;
mod voicevox;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::nim::{ChatMessage, NimClient, build_system_prompt};
use crate::settings::{Settings, get_api_key, load_settings, save_settings, set_api_key};

pub struct AppState {
    pub nim: Arc<NimClient>,
    pub settings: Mutex<Settings>,
    /// Live cancellation tokens per chat request id.
    pub cancellations: Mutex<HashMap<String, CancellationToken>>,
    /// Rolling conversation history (role, content) for context.
    pub history: Arc<Mutex<Vec<ChatMessage>>>,
}

fn new_cancel(state: &State<AppState>, id: &str) -> CancellationToken {
    let token = CancellationToken::new();
    state
        .cancellations
        .lock()
        .unwrap()
        .insert(id.to_string(), token.clone());
    token
}

// ---------- settings commands ----------

#[tauri::command]
fn cmd_get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn cmd_save_settings(
    app: AppHandle,
    state: State<AppState>,
    settings: Settings,
) -> Result<(), String> {
    save_settings(&app, &settings)?;
    *state.settings.lock().unwrap() = settings.clone();
    app.emit("settings://changed", &settings)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn cmd_has_api_key() -> bool {
    tauri::async_runtime::spawn_blocking(|| matches!(get_api_key(), Ok(Some(k)) if !k.is_empty()))
        .await
        .unwrap_or(false)
}

#[tauri::command]
fn cmd_set_api_key(key: String) -> Result<(), String> {
    set_api_key(key.trim())
}

#[tauri::command]
async fn cmd_test_connection(state: State<'_, AppState>) -> Result<String, String> {
    let settings = state.settings.lock().unwrap().clone();
    let key = get_api_key()?.ok_or("No API key configured")?;
    state.nim.test_connection(&settings, &key).await
}

// ---------- chat commands ----------

#[tauri::command]
fn cmd_cancel_chat(state: State<AppState>, id: String) {
    if let Some(token) = state.cancellations.lock().unwrap().remove(&id) {
        token.cancel();
    }
}

#[tauri::command]
async fn cmd_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    message: String,
) -> Result<(), String> {
    let settings = state.settings.lock().unwrap().clone();
    let key = get_api_key()?.ok_or("No NVIDIA API key configured")?;

    let system = ChatMessage {
        role: "system".into(),
        content: build_system_prompt(&settings),
    };

    let mut messages = vec![system];
    {
        let history = state.history.lock().unwrap();
        let max = (settings.remember_context_turns as usize) * 2;
        messages.extend(history.iter().rev().take(max).rev().cloned());
    }
    messages.push(ChatMessage {
        role: "user".into(),
        content: message,
    });

    let cancel = new_cancel(&state, &id);
    let nim = state.nim.clone();
    let history_arc = state.history.clone();

    tauri::async_runtime::spawn(async move {
        nim.chat_stream(app.clone(), id.clone(), settings, key, messages, cancel)
            .await;
        // Persist assistant turn is handled by frontend calling cmd_commit_turn
        // (frontend already owns the cleaned text + emo decision).
        let _ = history_arc;
        app.emit("nim://idle", serde_json::json!({"id": id})).ok();
    });

    Ok(())
}

#[tauri::command]
fn cmd_commit_turn(state: State<AppState>, user: String, assistant: String) {
    let mut history = state.history.lock().unwrap();
    history.push(ChatMessage {
        role: "user".into(),
        content: user,
    });
    history.push(ChatMessage {
        role: "assistant".into(),
        content: assistant,
    });
    // Hard cap: keep last 40 messages.
    if history.len() > 40 {
        let drop = history.len() - 40;
        history.drain(..drop);
    }
}

#[tauri::command]
fn cmd_clear_history(state: State<AppState>) {
    state.history.lock().unwrap().clear();
}

#[tauri::command]
fn cmd_report_avatar_status(status: String) {
    // No dialogue or credentials: only renderer lifecycle diagnostics.
    tracing::info!(status = %status.chars().take(300).collect::<String>(), "avatar renderer");
}

// ---------- companion window ----------

/// Create the frameless, transparent, always-on-top avatar window.
fn create_companion(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let win = WebviewWindowBuilder::new(
        app,
        "companion",
        WebviewUrl::App("index.html?mode=companion".into()),
    )
    .title("Companion")
    .inner_size(720.0, 600.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .shadow(false)
    .focused(false)
    .build()
    .map_err(|e| e.to_string())?;

    let companion = win.clone();
    let handle = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            recognition::cmd_stop_listening();
            let _ = handle.emit("avatar://stop-speech", ());
            let _ = companion.hide();
        }
    });

    // park it near the top-right corner of the primary screen
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let x = size.width as f64 / scale - 740.0;
        let y = 90.0;
        let _ = win.set_position(tauri::LogicalPosition::new(x, y));
    }

    Ok(win)
}

#[tauri::command]
async fn cmd_open_companion(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("companion") {
        let _ = w.show();
        return Ok(());
    }
    create_companion(&app).map(|_| ())
}

#[tauri::command]
fn cmd_close_companion(app: AppHandle) -> Result<(), String> {
    recognition::cmd_stop_listening();
    let _ = app.emit("avatar://stop-speech", ());
    if let Some(w) = app.get_webview_window("companion") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bring the control panel (settings/chat) forward.
#[tauri::command]
fn cmd_open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- init ----------

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let settings = load_settings(app.handle());
            app.manage(AppState {
                nim: Arc::new(NimClient::new()),
                settings: Mutex::new(settings),
                cancellations: Mutex::new(HashMap::new()),
                history: Arc::new(Mutex::new(Vec::new())),
            });

            // Launch the floating companion first, then hide the control
            // panel behind it. The panel reopens from the ⚙ button.
            if let Err(error) = create_companion(app.handle()) {
                tracing::error!("Failed to create companion: {error}");
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                }
            }

            // Closing the control panel should hide it, not end the app.
            if let Some(main) = app.get_webview_window("main") {
                let w = main.clone();
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            speech::cmd_synthesize_speech,
            voicevox::cmd_voicevox_status,
            recognition::cmd_start_listening,
            recognition::cmd_stop_listening,
            cmd_get_settings,
            cmd_report_avatar_status,
            cmd_save_settings,
            cmd_has_api_key,
            cmd_set_api_key,
            cmd_test_connection,
            cmd_chat,
            cmd_cancel_chat,
            cmd_commit_turn,
            cmd_clear_history,
            cmd_open_companion,
            cmd_close_companion,
            cmd_open_settings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(companion) = app.get_webview_window("companion") {
                    let _ = companion.show();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
