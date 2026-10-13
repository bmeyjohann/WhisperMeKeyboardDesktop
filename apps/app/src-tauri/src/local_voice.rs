// The test credential stays native and is never returned to the webview.
#[cfg(debug_assertions)]
#[derive(serde::Deserialize)]
struct Session { token: String, expires_at: u64 }

pub fn configured() -> bool {
    cfg!(debug_assertions) && std::env::var_os("WHISPERME_LOCAL_SESSION").is_some()
}

pub fn credentials(endpoint: String, token: String) -> Result<(String, String), String> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("WHISPERME_LOCAL_SESSION") {
        let session: Session = serde_json::from_slice(&std::fs::read(path).map_err(|_| "Local test session missing; restart the launcher")?)
            .map_err(|_| "Invalid local test session")?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "Invalid clock")?.as_millis();
        if session.token.len() < 32 || u128::from(session.expires_at) <= now { return Err("Local test session expired; restart the launcher".into()); }
        // Never let an editable provider endpoint receive this credential.
        return Ok(("ws://127.0.0.1:8877/realtime".into(), session.token));
    }
    Ok((endpoint, token))
}

#[tauri::command]
pub fn voice_local_mode() -> Result<bool, String> {
    if !configured() { return Ok(false); }
    credentials(String::new(), String::new()).map(|_| true)
}
