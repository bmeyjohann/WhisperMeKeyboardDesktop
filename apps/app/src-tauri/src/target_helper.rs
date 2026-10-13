//! One owned STA helper, with fresh function-scoped UIA state for every request.
use serde_json::Value;
use base64::Engine;
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

// One million UTF-16 units, duplicated snapshot slices and JSON escaping.
const MAX_RESPONSE: u64 = 20_000_000;
const TIMEOUT: Duration = Duration::from_secs(10);
struct Helper {
    child: Child,
    input: ChildStdin,
    responses: mpsc::Receiver<Result<Value, String>>,
}
impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Helper {
    fn start() -> Result<Self, String> {
        // Keep CreateProcess's command line below its 32,767 UTF-16 limit.
        // Bootstrap source is content-only base64; subsequent stdin lines are requests.
        const BOOTSTRAP: &str = "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())); & ([ScriptBlock]::Create($source)) -Persistent";
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", BOOTSTRAP])
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Could not open Windows text accessibility")?;
        let mut input = child.stdin.take().ok_or("Missing input pipe")?;
        let source = base64::engine::general_purpose::STANDARD.encode(include_bytes!("voice-target.ps1"));
        writeln!(input, "{source}").and_then(|_| input.flush())
            .map_err(|_| "Could not initialize Windows text accessibility")?;
        let output = child.stdout.take().ok_or("Missing output pipe")?;
        let (tx, responses) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = Vec::new();
                let read = (&mut reader)
                    .take(MAX_RESPONSE)
                    .read_until(b'\n', &mut line);
                if !matches!(read, Ok(n) if n > 0 && (n as u64) < MAX_RESPONSE) {
                    let _ = tx.send(Err(
                        "Windows accessibility helper stopped or returned excessive data".into(),
                    ));
                    break;
                }
                let response = serde_json::from_slice(&line)
                    .map_err(|_| "Invalid text target response".to_string());
                if tx.send(response).is_err() {
                    break;
                }
            }
        });
        let helper = Self {
            child,
            input,
            responses,
        };
        if helper
            .receive()?
            .get("helperReady")
            .and_then(Value::as_bool)
            != Some(true)
        {
            return Err("Windows accessibility helper did not become ready".into());
        }
        Ok(helper)
    }
    fn receive(&self) -> Result<Value, String> {
        self.responses.recv_timeout(TIMEOUT).map_err(|_| {
            "Text accessibility timed out or disconnected. Check the field before copying; an interrupted insertion is not retried.".to_string()
        })?
    }
    fn request(&mut self, request: Value) -> Result<Value, String> {
        let mut encoded =
            serde_json::to_vec(&request).map_err(|_| "Invalid text target request")?;
        if encoded.len() as u64 >= MAX_RESPONSE {
            return Err("Text target request is too large".into());
        }
        encoded.push(b'\n');
        self.input
            .write_all(&encoded)
            .and_then(|_| self.input.flush())
            .map_err(|_| "Windows accessibility helper disconnected")?;
        self.receive()
    }
}

fn shared() -> &'static Mutex<Option<Helper>> {
    static HELPER: OnceLock<Mutex<Option<Helper>>> = OnceLock::new();
    HELPER.get_or_init(|| Mutex::new(None))
}

pub fn request(request: Value) -> Result<Value, String> {
    let started = Instant::now();
    let capture = request["action"] == "capture";
    let mut slot = shared()
        .lock()
        .map_err(|_| "Text accessibility state unavailable")?;
    let lock_ms = started.elapsed().as_secs_f64() * 1000.0;
    let reused = slot.is_some();
    if slot.is_none() {
        *slot = Some(Helper::start()?);
    }
    let ready_ms = started.elapsed().as_secs_f64() * 1000.0;
    let result = slot.as_mut().unwrap().request(request);
    // Never replay a failed apply: it may already have changed the field.
    if result.is_err() {
        *slot = None;
    }
    let mut result = result?;
    if let Some(error) = result.get("error").and_then(Value::as_str) {
        return Err(error.into());
    }
    if capture {
        result["helperTiming"] = serde_json::json!({
            "reused":reused, "lockMs":lock_ms, "readyMs":ready_ms,
            "totalMs":started.elapsed().as_secs_f64() * 1000.0
        });
    }
    Ok(result)
}

pub fn warm() {
    thread::spawn(|| {
        if let Ok(mut slot) = shared().lock() {
            if slot.is_none() {
                *slot = Helper::start().ok();
            }
        }
    });
}

pub fn shutdown() {
    if let Ok(mut slot) = shared().lock() {
        *slot = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn helper_reuses_process_and_recovers_after_failure_without_replay() {
        shutdown();
        let first = request(serde_json::json!({"action":"helper.ping"})).unwrap();
        for _ in 0..4 {
            assert_eq!(
                request(serde_json::json!({"action":"helper.ping"})).unwrap(),
                first
            );
        }
        {
            let mut slot = shared().lock().unwrap();
            let helper = slot.as_mut().unwrap();
            helper.child.kill().unwrap();
            helper.child.wait().unwrap();
        }
        // The interrupted request must surface an error; only a later request restarts.
        assert!(request(serde_json::json!({"action":"helper.ping"})).is_err());
        assert_ne!(
            request(serde_json::json!({"action":"helper.ping"})).unwrap(),
            first
        );
        shutdown();
    }
}
