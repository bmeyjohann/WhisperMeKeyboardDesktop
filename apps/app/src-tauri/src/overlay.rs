use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use serde::{Deserialize, Serialize};
use tracing::{debug, error, info};

/// Explicitly show without activation on every transition, not only window creation.
fn show_without_activation(window: &WebviewWindow) -> tauri::Result<()> {
    #[cfg(target_os = "windows")]
    crate::overlay_windows::show(window)?;
    #[cfg(not(target_os = "windows"))]
    window.show()?;
    Ok(())
}

fn hide_without_activation(window: &WebviewWindow) -> tauri::Result<()> {
    #[cfg(target_os = "windows")]
    crate::overlay_windows::hide(window)?;
    #[cfg(not(target_os = "windows"))]
    window.hide()?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OverlayState {
    Hidden,
    Recording,
    Processing,
}

pub struct OverlayManager {
    app_handle: AppHandle,
    overlay_window: Option<WebviewWindow>,
    current_state: OverlayState,
}

impl OverlayManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            overlay_window: None,
            current_state: OverlayState::Hidden,
        }
    }

    /// Load the hidden WebView once at app startup, without changing active UI.
    pub fn prepare_overlay(&mut self) -> tauri::Result<()> {
        if self.overlay_window.is_none() { self.create_overlay_window()?; }
        Ok(())
    }

    /// Show the overlay window in the specified state
    pub fn show_overlay(&mut self, state: OverlayState) -> tauri::Result<()> {
        info!("Showing overlay in state: {:?}", state);
        
        self.prepare_overlay()?;

        if let Some(window) = &self.overlay_window {
            window.set_size(tauri::LogicalSize::new(420.0, 240.0))?;
            self.position_overlay()?;
            show_without_activation(window)?;
            // Processing can become a recoverable error/result without another native state change.
            // Keep every visible overlay interactive so Copy and Dismiss never click through.
            // Do not toggle Tao's cursor flags: its style rewrite removes WS_EX_NOACTIVATE.
            // Hidden windows cannot receive clicks; visible windows keep normal hit-testing.
            self.apply_state_to_window(window, &state);
            
            // Send state to the overlay window
            if let Err(e) = window.emit("overlay-state-changed", &state) {
                error!("Failed to emit overlay state: {}", e);
            }
        }

        self.current_state = state;
        Ok(())
    }

    /// Hide the overlay window
    pub fn hide_overlay(&mut self) -> tauri::Result<()> {
        info!("Hiding overlay");
        
        if let Some(window) = &self.overlay_window {
            hide_without_activation(window)?;
        }
        
        self.current_state = OverlayState::Hidden;
        Ok(())
    }

    /// Update the overlay state without showing/hiding
    pub fn update_state(&mut self, state: OverlayState) -> tauri::Result<()> {
        debug!("Updating overlay state to: {:?}", state);
        
        if let Some(window) = &self.overlay_window {
            match state {
                OverlayState::Hidden => {
                    hide_without_activation(window)?;
                }
                OverlayState::Recording => {
                    self.position_overlay()?;
                    show_without_activation(window)?;
                }
                OverlayState::Processing => {
                    self.position_overlay()?;
                    show_without_activation(window)?;
                }
            }
            self.apply_state_to_window(window, &state);

            if let Err(e) = window.emit("overlay-state-changed", &state) {
                error!("Failed to emit overlay state update: {}", e);
            }
        }
        
        self.current_state = state;
        Ok(())
    }

    /// Create the overlay window
    fn create_overlay_window(&mut self) -> tauri::Result<()> {
        info!("Creating overlay window");
        
        let window = WebviewWindowBuilder::new(
            &self.app_handle,
            "recording-overlay",
            tauri::WebviewUrl::App("overlay.html".into()),
        )
        .title("Recording Overlay")
        .decorations(false)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .transparent(true)
        .shadow(false)
        .focused(false)  // Prevent stealing focus from the current window
        .visible_on_all_workspaces(true)  // Show on all workspaces/virtual desktops
        .visible(false)
        .inner_size(420.0, 240.0)
        .build()?;
        // Windows activation/style protection is installed on the UI thread before showing.

        // Handle window events
        let window_clone = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Prevent the overlay from being closed directly
                api.prevent_close();
                let _ = hide_without_activation(&window_clone);
            }
        });

        self.overlay_window = Some(window);
        Ok(())
    }

    fn apply_state_to_window(&self, window: &WebviewWindow, state: &OverlayState) {
        let state_json = match serde_json::to_string(state) {
            Ok(value) => value,
            Err(e) => {
                error!("Failed to serialize overlay state: {}", e);
                return;
            }
        };
        let script = format!(
            "window.__WM_OVERLAY_SET_STATE && window.__WM_OVERLAY_SET_STATE({});",
            state_json
        );
        if let Err(e) = window.eval(&script) {
            debug!("Overlay state script skipped or failed: {}", e);
        }
    }

    /// Position the overlay at the bottom center of the active screen
    fn position_overlay(&self) -> tauri::Result<()> {
        if let Some(window) = &self.overlay_window {
            // Prefer current monitor, fallback to primary monitor.
            let monitor = match window.current_monitor()? {
                Some(current) => Some(current),
                None => window.primary_monitor()?,
            };

            if let Some(monitor) = monitor {
                let size = monitor.size();
                let position = monitor.position();

                // Calculate position (bottom center) in virtual screen coordinates.
                let window_width = window.outer_size()?.width as f64;
                let window_height = window.outer_size()?.height as f64;
                let x = position.x as f64 + (size.width as f64 - window_width) / 2.0;
                let y = position.y as f64 + size.height as f64 - window_height - 100.0;

                window.set_position(tauri::PhysicalPosition::new(
                    x.round() as i32,
                    y.round() as i32,
                ))?;
                debug!(
                    "Positioned overlay at ({}, {}) on monitor pos=({}, {}) size=({}x{})",
                    x,
                    y,
                    position.x,
                    position.y,
                    size.width,
                    size.height
                );
            }
        }
        Ok(())
    }

    pub fn get_current_state(&self) -> &OverlayState {
        &self.current_state
    }
}

/// Tauri commands for overlay management
#[tauri::command]
pub async fn show_recording_overlay(
    app_handle: AppHandle,
) -> Result<(), String> {
    let overlay = app_handle.state::<std::sync::Mutex<OverlayManager>>();
    let mut overlay = overlay.lock().map_err(|e| e.to_string())?;
    overlay.show_overlay(OverlayState::Recording).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn show_processing_overlay(
    app_handle: AppHandle,
) -> Result<(), String> {
    let overlay = app_handle.state::<std::sync::Mutex<OverlayManager>>();
    let mut overlay = overlay.lock().map_err(|e| e.to_string())?;
    overlay.update_state(OverlayState::Processing).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hide_recording_overlay(
    app_handle: AppHandle,
) -> Result<(), String> {
    let overlay = app_handle.state::<std::sync::Mutex<OverlayManager>>();
    let mut overlay = overlay.lock().map_err(|e| e.to_string())?;
    overlay.hide_overlay().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn voice_overlay_expand(app: AppHandle, expanded: bool) -> Result<(), String> {
    let overlay = app.state::<std::sync::Mutex<OverlayManager>>();
    let overlay = overlay.lock().map_err(|e| e.to_string())?;
    if let Some(window) = &overlay.overlay_window {
        window.set_size(tauri::LogicalSize::new(420.0, if expanded { 420.0 } else { 240.0 }))
            .map_err(|e| e.to_string())?;
        overlay.position_overlay().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_overlay_state(app_handle: AppHandle) -> Result<OverlayState, String> {
    let overlay = app_handle.state::<std::sync::Mutex<OverlayManager>>();
    let overlay = overlay.lock().map_err(|e| e.to_string())?;
    Ok(overlay.get_current_state().clone())
}

#[tauri::command]
pub async fn stop_recording_from_overlay(
    app_handle: AppHandle,
) -> Result<(), String> {
    // This will be called when the user clicks on the overlay
    // We need to trigger the stop recording command
    info!("Stop recording requested from overlay");
    
    // Emit an event that can be caught by the main app
    if let Some(main_window) = app_handle.get_webview_window("main") {
        main_window.emit("stop-recording-requested", ()).map_err(|e| e.to_string())?;
    }
    
    Ok(())
} 
