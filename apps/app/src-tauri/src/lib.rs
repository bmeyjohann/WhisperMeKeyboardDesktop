// Platform-specific modules
#[cfg(target_os = "macos")]
mod accessibility;

// Re-export platform-specific functions
#[cfg(target_os = "macos")]
use accessibility::{is_macos_accessibility_enabled, open_apple_accessibility};

pub mod recorder;
pub mod overlay;
#[cfg(target_os = "windows")]
mod overlay_windows;
pub mod context;
pub mod backend;
mod realtime;
mod local_voice;
use local_voice::voice_local_mode;
mod voice_target;
#[cfg(target_os = "windows")]
mod target_helper;
#[cfg(all(target_os = "windows", debug_assertions))]
mod native_smoke;
use voice_target::{voice_target_capture, voice_target_apply, voice_overlay_update};
use overlay::voice_overlay_expand;
use realtime::{voice_preferences_request, voice_backend_status, voice_stream_open, voice_stream_send, voice_stream_close, VoiceStreams};
pub mod auth;
use recorder::commands::{
    cancel_recording, close_recording_session, enumerate_recording_devices, get_recorder_state,
    init_recording_session, start_recording, stop_recording, AppData,
};
use overlay::{
    hide_recording_overlay, show_processing_overlay, show_recording_overlay, 
    stop_recording_from_overlay, get_overlay_state, OverlayManager,
};
use context::gather_context;
use backend::{process_voice_with_backend, test_backend_connection};
use auth::{auth0_token_request, get_stored_tokens, store_tokens, clear_stored_tokens, start_oauth_server, stop_oauth_server, get_oauth_callback, listen_oauth_callback, handle_deep_link, handle_deep_link_with_app, js_log};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(target_os = "windows", debug_assertions))]
    let native_smoke = native_smoke::enabled();
    #[cfg(not(all(target_os = "windows", debug_assertions)))]
    let native_smoke = false;
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppData::new())
        .manage(VoiceStreams::default());

    // When a new instance is opened, focus on the main window if it's already running
    // https://v2.tauri.app/plugin/single-instance/#focusing-on-new-instance
    #[cfg(desktop)]
    if !native_smoke {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    // Platform-specific command handlers
    #[cfg(target_os = "macos")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        voice_stream_open, voice_stream_send, voice_stream_close,
        voice_preferences_request, voice_backend_status, voice_local_mode,
        voice_target_capture, voice_target_apply, voice_overlay_update, voice_overlay_expand,
        write_text,
        open_apple_accessibility,
        is_macos_accessibility_enabled,
        // Audio recorder commands
        get_recorder_state,
        enumerate_recording_devices,
        init_recording_session,
        close_recording_session,
        start_recording,
        stop_recording,
        cancel_recording,
        // Overlay commands
        show_recording_overlay,
        show_processing_overlay,
        hide_recording_overlay,
        get_overlay_state,
        stop_recording_from_overlay,
        // Context gathering
        gather_context,
        // Backend integration
        process_voice_with_backend,
        test_backend_connection,
        // Auth commands
        auth0_token_request,
        get_stored_tokens,
        store_tokens,
        clear_stored_tokens,
        start_oauth_server,
        stop_oauth_server,
        get_oauth_callback,
        listen_oauth_callback,
        handle_deep_link,
        handle_deep_link_with_app,
        js_log,
    ]);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        voice_stream_open, voice_stream_send, voice_stream_close,
        voice_preferences_request, voice_backend_status, voice_local_mode,
        voice_target_capture, voice_target_apply, voice_overlay_update, voice_overlay_expand,
        write_text,
        // Audio recorder commands
        get_recorder_state,
        enumerate_recording_devices,
        init_recording_session,
        close_recording_session,
        start_recording,
        stop_recording,
        cancel_recording,
        // Overlay commands
        show_recording_overlay,
        show_processing_overlay,
        hide_recording_overlay,
        get_overlay_state,
        stop_recording_from_overlay,
        // Context gathering
        gather_context,
        // Backend integration
        process_voice_with_backend,
        test_backend_connection,
        // Auth commands
        auth0_token_request,
        get_stored_tokens,
        store_tokens,
        clear_stored_tokens,
        start_oauth_server,
        stop_oauth_server,
        get_oauth_callback,
        listen_oauth_callback,
        handle_deep_link,
        handle_deep_link_with_app,
        js_log,
    ]);

    let mut context = tauri::generate_context!();
    if native_smoke {
        // A separate profile and inert page keep tests away from account state and microphones.
        context.config_mut().identifier = "app.whisperme.desktop.native-smoke".into();
        if std::env::args().any(|arg| arg == "--native-editor-fixture") {
            context.config_mut().identifier = "app.whisperme.desktop.native-smoke-editor".into();
        }
        for window in &mut context.config_mut().app.windows {
            window.visible = false;
            window.focus = false;
            window.url = tauri::WebviewUrl::App("native-smoke.html".into());
        }
    }
    if local_voice::configured() {
        context.config_mut().identifier = "app.whisperme.desktop.local-test".into();
        for window in &mut context.config_mut().app.windows {
            window.title = "WhisperMe — LOCAL TEST".into();
        }
    }
    let app = builder
        .build(context)
        .expect("error while building tauri application");

    // Initialize overlay manager after app is created
    let overlay_manager = std::sync::Mutex::new(OverlayManager::new(app.handle().clone()));
    app.manage(overlay_manager);

    // Deep link handling will be done through the plugin's events

    app.run(move |_app_handle, event| {
        if matches!(event, tauri::RunEvent::Ready) {
            let handle = _app_handle.clone();
            std::thread::spawn(move || {
                if let Ok(mut overlay) = handle.state::<std::sync::Mutex<OverlayManager>>().lock() {
                    if let Err(error) = overlay.prepare_overlay() {
                        tracing::warn!("Overlay preload failed; will retry when recording: {error}");
                    }
                };
            });
        }
        #[cfg(target_os = "windows")]
        if matches!(event, tauri::RunEvent::Ready) { target_helper::warm(); }
        #[cfg(target_os = "windows")]
        if matches!(event, tauri::RunEvent::Exit) { target_helper::shutdown(); }
        #[cfg(all(target_os = "windows", debug_assertions))]
        if native_smoke && matches!(event, tauri::RunEvent::Ready) {
            native_smoke::start(_app_handle.clone());
        }
        if let tauri::RunEvent::ExitRequested { .. } = event {
            // Cleanup can be added here if needed
        }
    });
}

use enigo::{Enigo, Keyboard, Settings};
use tauri::Manager;

/// Write text to the active application using the Enigo library
#[tauri::command]
fn write_text(text: String) -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).unwrap();
    enigo.text(&text).map_err(|e| e.to_string())
}
