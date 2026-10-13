use serde_json::Value;

#[cfg(target_os = "windows")]
pub(crate) fn target_request(request: Value) -> Result<Value, String> {
    crate::target_helper::request(request)
}

#[cfg(not(target_os = "windows"))]
fn target_request(_request: Value) -> Result<Value, String> {
    Err("Verified native editing is currently available on Windows. Use copy result for this platform.".into())
}

#[tauri::command]
pub async fn voice_target_capture() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| target_request(serde_json::json!({"action":"capture"}))).await.map_err(|_| "Target task failed")?
}

#[tauri::command]
pub async fn voice_target_apply(snapshot: Value, text: String, cursor_position: Option<usize>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || target_request(serde_json::json!({"action":"apply", "snapshot":snapshot, "text":text, "cursorPosition":cursor_position}))).await.map_err(|_| "Target task failed")?
}

#[tauri::command]
pub fn voice_overlay_update(app: tauri::AppHandle, data: Value) -> Result<(), String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("recording-overlay") {
        window.eval(&format!("window.__WM_VOICE = {}; window.__WM_RENDER_VOICE?.();", data)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
