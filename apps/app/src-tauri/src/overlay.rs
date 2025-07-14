use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use serde::{Deserialize, Serialize};
use tracing::{debug, error, info};

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

    /// Show the overlay window in the specified state
    pub fn show_overlay(&mut self, state: OverlayState) -> tauri::Result<()> {
        info!("Showing overlay in state: {:?}", state);
        
        if self.overlay_window.is_none() {
            self.create_overlay_window()?;
        }

        if let Some(window) = &self.overlay_window {
            window.show()?;
            window.set_always_on_top(true)?;
            self.position_overlay()?;
            
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
            window.hide()?;
        }
        
        self.current_state = OverlayState::Hidden;
        Ok(())
    }

    /// Update the overlay state without showing/hiding
    pub fn update_state(&mut self, state: OverlayState) -> tauri::Result<()> {
        debug!("Updating overlay state to: {:?}", state);
        
        if let Some(window) = &self.overlay_window {
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
        .inner_size(220.0, 60.0)  // Slightly wider and more compact for better content fit
        .build()?;

        // Handle window events
        let window_clone = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // Prevent the overlay from being closed directly
                let _ = window_clone.hide();
            }
        });

        self.overlay_window = Some(window);
        Ok(())
    }

    /// Position the overlay at the bottom center of the active screen
    fn position_overlay(&self) -> tauri::Result<()> {
        if let Some(window) = &self.overlay_window {
            // Get the primary monitor size
            if let Some(monitor) = window.primary_monitor()? {
                let size = monitor.size();
                let scale_factor = monitor.scale_factor();
                
                // Calculate position (bottom center)
                let window_width = 220.0;
                let window_height = 60.0;
                let x = (size.width as f64 / scale_factor - window_width) / 2.0;
                let y = size.height as f64 / scale_factor - window_height - 100.0; // 100px from bottom
                
                window.set_position(tauri::PhysicalPosition::new(x, y))?;
                debug!("Positioned overlay at ({}, {})", x, y);
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