use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::{collections::HashMap, sync::Mutex};
use tauri::{Emitter, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use base64::Engine;

fn pcm_duration(message: &str) -> Option<std::time::Duration> {
    let event: Value = serde_json::from_str(message).ok()?;
    if event.get("type")?.as_str()? != "audio.chunk" { return None; }
    let encoded = event.get("payload")?.get("audio")?.as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    Some(std::time::Duration::from_secs_f64(bytes.len() as f64 / 32000.0))
}

// Catch up after the handshake without submitting an unbounded provider backlog.
// Four seconds leaves headroom below the existing Muse five-second backlog budget.
struct PcmPacer { start: Option<tokio::time::Instant>, sent: std::time::Duration }
impl PcmPacer {
    fn new() -> Self { Self { start: None, sent: std::time::Duration::ZERO } }
    async fn wait(&mut self, duration: std::time::Duration) {
        let start = *self.start.get_or_insert_with(tokio::time::Instant::now);
        self.sent += duration;
        let offset = self.sent.saturating_sub(std::time::Duration::from_secs(4));
        tokio::time::sleep_until(start + offset).await;
    }
}

// Native timers continue measuring when the WebView is in the background.
#[derive(Default)]
struct ConnectionHeartbeat {
    enabled: bool,
    nonce: u64,
    pending: Option<(u64, std::time::Instant)>,
    missed: u32,
}
impl ConnectionHeartbeat {
    fn ping(&mut self, now: std::time::Instant) -> Value {
        if self.pending.is_some() { self.missed = self.missed.saturating_add(1); }
        self.nonce += 1;
        self.pending = Some((self.nonce, now));
        serde_json::json!({"type":"connection.ping", "nonce": self.nonce})
    }
    fn pong(&mut self, nonce: u64, now: std::time::Instant) -> Option<Value> {
        let (expected, sent) = self.pending?;
        if nonce != expected { return None; }
        self.pending = None;
        self.missed = 0;
        Some(serde_json::json!({"type":"connection.quality", "rttMs": now.duration_since(sent).as_millis() as u64, "missed": 0}))
    }
}

#[derive(Default)]
pub struct VoiceStreams(Mutex<HashMap<String, mpsc::Sender<String>>>);

#[tauri::command]
pub async fn voice_preferences_request(endpoint: String, token: String, path: String,
    method: String, body: Option<Value>) -> Result<Value, String> {
    if !matches!((path.as_str(), method.as_str()), ("/preferences", "GET" | "POST" | "PUT" | "DELETE") | ("/style-profile" | "/process-transcript", "POST")) {
        return Err("Unsupported preferences operation".into());
    }
    let (endpoint, token) = crate::local_voice::credentials(endpoint, token)?;
    let mut url = url::Url::parse(&endpoint).map_err(|_| "Invalid endpoint")?;
    if !url.username().is_empty() || url.password().is_some() { return Err("Endpoint must not contain credentials".into()); }
    let scheme = match url.scheme() {
        "wss" => "https", "ws" if matches!(url.host_str(), Some("127.0.0.1" | "localhost")) => "http",
        _ => return Err("Use a secure WhisperMe endpoint".into()),
    };
    url.set_scheme(scheme).map_err(|_| "Invalid endpoint")?;
    url.set_path(&path); url.set_query(None); url.set_fragment(None);
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "Could not create request")?;
    let mut request = client.request(method.parse().map_err(|_| "Invalid method")?, url)
        .bearer_auth(token).timeout(std::time::Duration::from_secs(if matches!(path.as_str(), "/process-transcript" | "/style-profile") { 160 } else { 30 }));
    if let Some(body) = body { request = request.json(&body); }
    let response = request.send().await.map_err(|e| format!("Preferences request failed: {}", e.without_url()))?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|_| "Server returned an invalid response")?;
    if matches!(path.as_str(), "/process-transcript" | "/style-profile") && value.get("success").and_then(Value::as_bool) == Some(false) {
        return Ok(value); // Preserve diagnostic context and usage when final processing failed.
    }
    if !status.is_success() { return Err(format!("HTTP {}: {}", status, value.get("error").and_then(Value::as_str).unwrap_or("Preferences request failed"))); }
    Ok(value)
}

#[tauri::command]
pub async fn voice_backend_status(endpoint: String, token: String) -> Result<Value, String> {
    let (endpoint, token) = crate::local_voice::credentials(endpoint, token)?;
    let mut url = url::Url::parse(&endpoint).map_err(|_| "Invalid endpoint")?;
    let scheme = match url.scheme() {
        "wss" => "https", "ws" if matches!(url.host_str(), Some("127.0.0.1" | "localhost")) => "http",
        _ => return Err("Use a secure WhisperMe websocket endpoint".into()),
    };
    url.set_scheme(scheme).map_err(|_| "Invalid endpoint")?;
    url.set_path("/capabilities"); url.set_query(None);
    let response = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().map_err(|e|e.to_string())?
        .get(url).bearer_auth(token).timeout(std::time::Duration::from_secs(10)).send().await.map_err(|e| format!("Backend network/TLS error: {}", e.without_url()))?;
    if !response.status().is_success() { return Err(format!("Backend returned {}", response.status())); }
    response.json().await.map_err(|_| "Backend does not support voice protocol v2".into())
}

#[tauri::command]
pub async fn voice_stream_open(app: tauri::AppHandle, state: State<'_, VoiceStreams>,
    id: String, endpoint: String, token: String) -> Result<(), String> {
    let (endpoint, token) = crate::local_voice::credentials(endpoint, token)?;
    let url = url::Url::parse(&endpoint).map_err(|_| "Invalid realtime endpoint")?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "wss" && !(local && url.scheme() == "ws") { return Err("Use wss://, or ws:// on localhost".into()); }
    if !url.username().is_empty() || url.password().is_some() { return Err("Endpoint must not contain credentials".into()); }
    let mut request = endpoint.into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert("Authorization", format!("Bearer {token}").parse().map_err(|_| "Invalid token")?);
    let (socket, _) = tokio::time::timeout(std::time::Duration::from_secs(15), tokio_tungstenite::connect_async(request))
        .await.map_err(|_| "Connection timed out")?.map_err(|error| match error {
            tokio_tungstenite::tungstenite::Error::Http(response) => match response.status().as_u16() {
                401 => "Backend returned HTTP 401 Unauthorized: sign-in needs refreshing.".to_string(),
                403 => "Backend returned HTTP 403 Forbidden: this account does not have access.".to_string(),
                _ => format!("Realtime backend returned HTTP {}", response.status()),
            },
            tokio_tungstenite::tungstenite::Error::Tls(_) => "Secure connection failed: check Windows certificates, VPN or HTTPS inspection.".to_string(),
            tokio_tungstenite::tungstenite::Error::Io(e) => format!("Realtime network error: {e}"),
            _ => "Realtime websocket handshake failed".to_string(),
        })?;
    let (tx, mut rx) = mpsc::channel::<String>(1);
    state.0.lock().map_err(|_| "Voice state unavailable")?.insert(id.clone(), tx);
    tauri::async_runtime::spawn(async move {
        let (mut output, mut input) = socket.split();
        let mut pacer = PcmPacer::new();
        let mut heartbeat = ConnectionHeartbeat::default();
        let mut heartbeat_tick = tokio::time::interval(std::time::Duration::from_secs(4));
        heartbeat_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = heartbeat_tick.tick(), if heartbeat.enabled => {
                    let ping = heartbeat.ping(std::time::Instant::now());
                    if heartbeat.missed > 0 {
                        let _ = app.emit("voice-stream-event", serde_json::json!({"id": id, "event": {"type":"connection.quality", "missed": heartbeat.missed}}));
                    }
                    if output.send(Message::Text(ping.to_string().into())).await.is_err() { break; }
                },
                message = rx.recv() => match message {
                    Some(text) => {
                        if let Ok(event) = serde_json::from_str::<Value>(&text) {
                            if event.get("type").and_then(Value::as_str) == Some("connection.configure") {
                                heartbeat.enabled = event.get("enabled").and_then(Value::as_bool) == Some(true);
                                continue;
                            }
                        }
                        // Native timers are unaffected by WebView background throttling.
                        if let Some(duration) = pcm_duration(&text) { pacer.wait(duration).await; }
                        if output.send(Message::Text(text.into())).await.is_err() { break; }
                    }
                    None => { let _ = output.close().await; break; }
                },
                incoming = input.next() => match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(event) = serde_json::from_str::<Value>(&text) {
                            if event.get("type").and_then(Value::as_str) == Some("connection.pong") {
                                if let Some(quality) = event.get("nonce").and_then(Value::as_u64).and_then(|nonce| heartbeat.pong(nonce, std::time::Instant::now())) {
                                    let _ = app.emit("voice-stream-event", serde_json::json!({"id": id, "event": quality}));
                                }
                                continue;
                            }
                            let _ = app.emit("voice-stream-event", serde_json::json!({"id": id, "event": event}));
                        }
                    }
                    Some(Ok(Message::Ping(data))) => { let _ = output.send(Message::Pong(data)).await; }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
        let _ = app.emit("voice-stream-event", serde_json::json!({"id": id, "event": {"type":"transport.closed"}}));
        use tauri::Manager;
        if let Ok(mut streams) = app.state::<VoiceStreams>().0.lock() { streams.remove(&id); };
    });
    Ok(())
}

#[tauri::command]
pub async fn voice_stream_send(state: State<'_, VoiceStreams>, id: String, message: String) -> Result<(), String> {
    if message.len() > 100000 { return Err("Voice message too large".into()); }
    let sender = {
        let streams = state.0.lock().map_err(|_| "Voice state unavailable")?;
        streams.get(&id).cloned().ok_or("Voice session closed")?
    };
    sender.send(message).await.map_err(|_| "Voice session closed before audio could be sent".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn heartbeat_matches_nonce_measures_rtt_and_recovers() {
        let now = std::time::Instant::now();
        let mut heartbeat = ConnectionHeartbeat::default();
        assert!(!heartbeat.enabled);
        assert_eq!(heartbeat.ping(now)["nonce"], 1);
        assert!(heartbeat.pong(99, now).is_none());
        assert_eq!(heartbeat.pong(1, now + std::time::Duration::from_millis(230)).unwrap()["rttMs"], 230);
        assert!(heartbeat.pong(1, now).is_none());
        heartbeat.ping(now);
        heartbeat.ping(now + std::time::Duration::from_secs(4));
        assert_eq!(heartbeat.missed, 1);
        assert!(heartbeat.pong(2, now + std::time::Duration::from_secs(4)).is_none());
        assert!(heartbeat.pong(3, now + std::time::Duration::from_secs(5)).is_some());
        assert_eq!(heartbeat.missed, 0);
    }
    #[tokio::test]
    async fn buffered_pcm_catches_up_then_bounds_provider_backlog() {
        let encoded = base64::engine::general_purpose::STANDARD.encode([0u8; 3200]);
        let message = serde_json::json!({"type":"audio.chunk","payload":{"audio":encoded}}).to_string();
        assert_eq!(pcm_duration(&message), Some(std::time::Duration::from_millis(100)));
        assert!(pcm_duration(r#"{"type":"session.stop"}"#).is_none());
        let mut pacer = PcmPacer::new();
        let start = std::time::Instant::now();
        for _ in 0..30 { pacer.wait(pcm_duration(&message).unwrap()).await; }
        assert!(start.elapsed() < std::time::Duration::from_millis(500));
        for _ in 0..12 { pacer.wait(pcm_duration(&message).unwrap()).await; }
        assert!(start.elapsed() >= std::time::Duration::from_millis(100));
    }
}

#[tauri::command]
pub fn voice_stream_close(state: State<'_, VoiceStreams>, id: String) -> Result<(), String> {
    state.0.lock().map_err(|_| "Voice state unavailable")?.remove(&id);
    Ok(())
}
