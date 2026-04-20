#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{env, sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};

// ─── shared state ────────────────────────────────────────────────────────────

struct AppState {
    ws_tx:       Arc<Mutex<Option<mpsc::UnboundedSender<Message>>>>,
    backend_url: String,
    backend_ws:  String,
}

// ─── WebSocket loop (reconnects every 3 s on failure) ────────────────────────

async fn ws_loop(app: AppHandle, state: Arc<AppState>) {
    loop {
        match connect_async(&state.backend_ws).await {
            Ok((ws, _)) => {
                println!("[WS] connected to {}", state.backend_ws);
                let _ = app.emit("ws-status", "connected");

                let (mut sink, mut stream) = ws.split();
                let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
                *state.ws_tx.lock().await = Some(tx);

                // forward outgoing messages to WS
                let write_task = tokio::spawn(async move {
                    while let Some(msg) = rx.recv().await {
                        if sink.send(msg).await.is_err() {
                            break;
                        }
                    }
                });

                // handle incoming messages from backend
                while let Some(Ok(msg)) = stream.next().await {
                    if let Message::Text(text) = msg {
                        let Ok(v) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        match v["type"].as_str().unwrap_or("") {
                            "connected" => {}
                            "session_started" => {
                                let _ = app.emit("session-started", v["sessionId"].as_str().unwrap_or(""));
                            }
                            "processing" => {
                                let _ = app.emit("processing", ());
                            }
                            "call_analyzed" => {
                                let _ = app.emit("call-analyzed", v.clone());
                                // surface OS-level notification via tray tooltip (lightweight)
                                if let Some(score) = v["analysis"]["score"].as_u64() {
                                    let _ = app.emit(
                                        "notify",
                                        format!("Звонок проанализирован · Оценка: {}/100", score),
                                    );
                                }
                            }
                            "error" => {
                                let _ = app.emit(
                                    "stream-error",
                                    v["error"].as_str().unwrap_or("Unknown error"),
                                );
                            }
                            "call_saved" | "contact_saved" | "call_started" => {
                                let _ = app.emit("data-updated", v["type"].as_str().unwrap_or(""));
                            }
                            _ => {}
                        }
                    }
                }

                write_task.abort();
                *state.ws_tx.lock().await = None;
                println!("[WS] disconnected, retrying in 3 s…");
                let _ = app.emit("ws-status", "disconnected");
            }
            Err(e) => {
                eprintln!("[WS] connect error: {e}");
                let _ = app.emit("ws-status", "disconnected");
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

// ─── REST proxy commands ──────────────────────────────────────────────────────

#[tauri::command]
async fn api_get(endpoint: String, state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let url = format!("{}{}", state.backend_url, endpoint);
    reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn api_post(
    endpoint: String,
    body: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    let url = format!("{}{}", state.backend_url, endpoint);
    reqwest::Client::new()
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn api_put(
    endpoint: String,
    body: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    let url = format!("{}{}", state.backend_url, endpoint);
    reqwest::Client::new()
        .put(&url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn api_delete(endpoint: String, state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let url = format!("{}{}", state.backend_url, endpoint);
    reqwest::Client::new()
        .delete(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<Value>()
        .await
        .map_err(|e| e.to_string())
}

// ─── WebSocket control commands ───────────────────────────────────────────────

#[tauri::command]
async fn start_recording(
    phone: String,
    manager_id: u32,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let msg = json!({
        "type": "call_start",
        "phone": phone,
        "managerId": manager_id,
        "deviceType": "desktop"
    });
    if let Some(tx) = state.ws_tx.lock().await.as_ref() {
        tx.send(Message::Text(msg.to_string()))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn stop_recording(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let msg = json!({ "type": "call_end" });
    if let Some(tx) = state.ws_tx.lock().await.as_ref() {
        tx.send(Message::Text(msg.to_string()))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn send_audio_chunk(
    chunk: Vec<u8>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if let Some(tx) = state.ws_tx.lock().await.as_ref() {
        // fire-and-forget — don't block on slow WS write
        tx.send(Message::Binary(chunk)).ok();
    }
    Ok(())
}

// ─── main ─────────────────────────────────────────────────────────────────────

fn main() {
    let backend_url = env::var("BACKEND_URL")
        .unwrap_or_else(|_| "http://localhost:3001".to_string());
    let backend_ws = env::var("BACKEND_WS")
        .unwrap_or_else(|_| "ws://localhost:3001".to_string());

    let ws_state = Arc::new(AppState {
        ws_tx: Arc::new(Mutex::new(None)),
        backend_url,
        backend_ws,
    });

    tauri::Builder::default()
        .manage(ws_state.clone())
        .setup(move |app| {
            // ── system tray ──────────────────────────────────────────────
            let show_item = MenuItem::with_id(app, "show", "Показать", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Выход",    true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .menu_on_left_click(false)
                .tooltip("Sales Analyzer")
                .on_tray_icon_event(|tray, event| {
                    // left-click toggles window visibility
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // ── minimize to tray on window close ─────────────────────────
            let win = app.get_webview_window("main").unwrap();
            let win2 = win.clone();
            win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = win2.hide();
                }
            });

            // ── start persistent WS connection ───────────────────────────
            let handle = app.handle().clone();
            let state  = ws_state.clone();
            tauri::async_runtime::spawn(async move {
                ws_loop(handle, state).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api_get, api_post, api_put, api_delete,
            start_recording, stop_recording, send_audio_chunk,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
