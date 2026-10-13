//! Debug-only, stdin-driven integration adapter. No network listener, auth or microphone.
//! The runner owns the editor and checks focus before issuing any capture/apply request.
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tauri::{Listener, Manager};

pub fn enabled() -> bool {
    std::env::args().any(|arg| arg == "--native-overlay-smoke")
}

#[repr(C)]
#[derive(Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> *mut std::ffi::c_void;
    fn GetWindowLongPtrW(hwnd: *mut std::ffi::c_void, index: i32) -> isize;
    fn IsWindowVisible(hwnd: *mut std::ffi::c_void) -> i32;
    fn GetWindowRect(hwnd: *mut std::ffi::c_void, rect: *mut Rect) -> i32;
}

fn inspect(app: &tauri::AppHandle, stops: &AtomicUsize) -> Result<Value, String> {
    let mut result = json!({
        "foreground": unsafe { GetForegroundWindow() } as usize,
        "stopEvents": stops.load(Ordering::SeqCst),
    });
    if let Some(window) = app.get_webview_window("recording-overlay") {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as *mut std::ffi::c_void;
        let mut rect = Rect::default();
        unsafe {
            GetWindowRect(hwnd, &mut rect);
            let extended = GetWindowLongPtrW(hwnd, -20);
            result["overlay"] = json!({
                "hwnd": hwnd as usize,
                "visible": IsWindowVisible(hwnd) != 0,
                "noActivate": extended & 0x08000000 != 0,
                "topmost": extended & 8 != 0,
                "clickThrough": extended & 0x20 != 0,
                "rect": {"left":rect.left,"top":rect.top,"right":rect.right,"bottom":rect.bottom},
            });
        }
    }
    Ok(result)
}

fn dispatch(app: &tauri::AppHandle, request: Value, stops: &AtomicUsize) -> Result<Value, String> {
    use crate::overlay::{OverlayManager, OverlayState};
    match request["action"].as_str().unwrap_or("") {
        "target" => crate::voice_target::target_request(request["request"].clone()),
        "show" => {
            let state = if request["state"] == "processing" {
                OverlayState::Processing
            } else {
                OverlayState::Recording
            };
            app.state::<std::sync::Mutex<OverlayManager>>()
                .lock()
                .map_err(|e| e.to_string())?
                .show_overlay(state)
                .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "processing" => {
            app.state::<std::sync::Mutex<OverlayManager>>()
                .lock()
                .map_err(|e| e.to_string())?
                .update_state(OverlayState::Processing)
                .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "render" => {
            crate::voice_target::voice_overlay_update(app.clone(), request["data"].clone())?;
            Ok(json!({}))
        }
        "expand" => {
            crate::overlay::voice_overlay_expand(
                app.clone(),
                request["expanded"].as_bool().unwrap_or(false),
            )?;
            Ok(json!({}))
        }
        "hide" => {
            app.state::<std::sync::Mutex<OverlayManager>>()
                .lock()
                .map_err(|e| e.to_string())?
                .hide_overlay()
                .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "close" => {
            app.get_webview_window("recording-overlay")
                .ok_or("Overlay not created")?
                .close()
                .map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "inspect" => inspect(app, stops),
        "editor" => {
            let window = app
                .get_webview_window("main")
                .ok_or("Smoke editor missing")?;
            window
                .set_title("WhisperMe owned WebView2 test editor")
                .map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            Ok(json!({"hwnd":window.hwnd().map_err(|e| e.to_string())?.0 as usize}))
        }
        "field" => {
            let field = request["field"].as_str().unwrap_or("");
            if !matches!(field, "smoke-textarea" | "smoke-rich" | "smoke-single" |
                "smoke-placeholder-input" | "smoke-placeholder-rich" | "smoke-placeholder-literal" | "smoke-format-rich") {
                return Err("Unknown fixture field".into());
            }
            let window = app
                .get_webview_window("main")
                .ok_or("Smoke editor missing")?;
            window.set_focus().map_err(|e| e.to_string())?;
            window.eval(&format!(r#"(() => {{
                const editor = document.getElementById('{field}'); editor.focus();
                if (editor.setSelectionRange) editor.setSelectionRange(editor.value.length, editor.value.length);
                else {{ const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
                    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }}
            }})()"#)).map_err(|e| e.to_string())?;
            Ok(json!({}))
        }
        "dom" => {
            let label = if request["target"] == "editor" {
                "main"
            } else {
                "recording-overlay"
            };
            let window = app
                .get_webview_window(label)
                .ok_or("Test window not created")?;
            let (sender, receiver) = std::sync::mpsc::channel();
            let listener = app.listen("native-smoke-dom", move |event| {
                let _ = sender.send(event.payload().to_string());
            });
            let evaluated = window.eval(r#"(() => {
                const root = document.getElementById('overlay');
                window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
                    event: 'native-smoke-dom', payload: {
                        ready: !!window.__WM_RENDER_VOICE, state: document.readyState,
                        title: document.title, rootHidden: root?.hidden ?? true,
                        scale: window.devicePixelRatio,
                        fields: [...document.querySelectorAll('input,textarea,[contenteditable]')].map(editor => {
                            let start=editor.selectionStart, end=editor.selectionEnd;
                            if (editor.isContentEditable && window.getSelection()?.rangeCount) {
                                const selected=window.getSelection().getRangeAt(0);
                                if (editor.contains(selected.startContainer) && editor.contains(selected.endContainer)) {
                                    const prefix=selected.cloneRange(); prefix.selectNodeContents(editor);
                                    prefix.setEnd(selected.startContainer,selected.startOffset);start=prefix.toString().length;
                                    prefix.setEnd(selected.endContainer,selected.endOffset);end=prefix.toString().length;
                                }
                            }
                            return {id:editor.id, text:editor.value ?? editor.textContent,
                                formatting:[...editor.querySelectorAll('strong,b,a,em')].map(node=>({tag:node.tagName,text:node.textContent,href:node.getAttribute('href')})),
                                focused:document.activeElement === editor,selectionStart:start,selectionEnd:end};
                        }),
                        buttons: [...document.querySelectorAll('button')].map(button => {
                            const rect = button.getBoundingClientRect();
                            return { id: button.id, name: button.getAttribute('aria-label') || button.textContent,
                                x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                        })
                    }
                });
            })()"#);
            let response = evaluated.map_err(|e| e.to_string()).and_then(|_| {
                receiver
                    .recv_timeout(std::time::Duration::from_secs(3))
                    .map_err(|_| "Overlay DOM probe timed out".to_string())
            });
            app.unlisten(listener);
            serde_json::from_str(&response?).map_err(|e| e.to_string())
        }
        _ => Err("Unknown native smoke action".into()),
    }
}

fn reply(value: Value) {
    let mut output = std::io::stdout().lock();
    let _ = writeln!(output, "WHISPERME_SMOKE {value}");
    let _ = output.flush();
}

pub fn start(app: tauri::AppHandle) {
    let stops = Arc::new(AtomicUsize::new(0));
    let count = stops.clone();
    app.listen("stop-recording-requested", move |_| {
        count.fetch_add(1, Ordering::SeqCst);
    });
    std::thread::spawn(move || {
        reply(json!({"ready":true,"pid":std::process::id()}));
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else {
                break;
            };
            let response = match serde_json::from_str::<Value>(line.trim_start_matches('\u{feff}'))
            {
                Ok(request) if request["action"] == "exit" => break,
                Ok(request) => match dispatch(&app, request, &stops) {
                    Ok(result) => json!({"ok":true,"result":result}),
                    Err(error) => json!({"ok":false,"error":error}),
                },
                Err(error) => json!({"ok":false,"error":format!("Invalid smoke JSON: {error}")}),
            };
            reply(response);
        }
        app.exit(0);
    });
}
