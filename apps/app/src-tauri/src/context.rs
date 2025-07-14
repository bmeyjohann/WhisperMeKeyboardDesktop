use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

#[cfg(target_os = "macos")]
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceContext {
    pub text_before_cursor: String,
    pub text_after_cursor: String,
    pub selected_text: String,
    pub cursor_position: i32,
    pub full_text: String,
    pub package_name: String,
    pub field_type: Option<String>,
    pub field_hint: Option<String>,
    pub field_label: Option<String>,
    pub is_password_field: bool,
    pub is_rich_editor: bool,
    pub keyboard_mode: String,
    pub input_shift_state: String,
    pub locale: String,
    pub content_mime_types: Option<Vec<String>>,
    pub ime_options: ImeOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImeOptions {
    pub action: String,
    pub flag_no_enter_action: bool,
    pub flag_no_personalized_learning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub window_title: String,
    pub application_name: String,
    pub bundle_id: String,
    pub process_name: String,
}

impl Default for VoiceContext {
    fn default() -> Self {
        Self {
            text_before_cursor: String::new(),
            text_after_cursor: String::new(),
            selected_text: String::new(),
            cursor_position: 0,
            full_text: String::new(),
            package_name: String::new(),
            field_type: None,
            field_hint: None,
            field_label: None,
            is_password_field: false,
            is_rich_editor: false,
            keyboard_mode: "text".to_string(),
            input_shift_state: "unshifted".to_string(),
            locale: "en-US".to_string(),
            content_mime_types: None,
            ime_options: ImeOptions {
                action: "done".to_string(),
                flag_no_enter_action: false,
                flag_no_personalized_learning: false,
            },
        }
    }
}

/// Get the currently active window information
#[cfg(target_os = "macos")]
pub fn get_active_window_info() -> Result<WindowInfo, String> {
    use core_foundation::base::TCFType;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    
    // Use AppleScript to get window information
    let script = r#"
    tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        set bundleId to bundle identifier of frontApp
        try
            set windowTitle to title of front window of frontApp
        on error
            set windowTitle to ""
        end try
        return appName & "|" & bundleId & "|" & windowTitle
    end tell
    "#;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("Failed to execute AppleScript: {}", e))?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!("AppleScript failed: {}", error));
    }

    let result = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = result.trim().split('|').collect();
    
    if parts.len() < 3 {
        return Err("Invalid AppleScript output format".to_string());
    }

    Ok(WindowInfo {
        application_name: parts[0].to_string(),
        bundle_id: parts[1].to_string(),
        window_title: parts[2].to_string(),
        process_name: parts[0].to_string(), // Use app name as process name for now
    })
}

/// Get text field information using accessibility API
#[cfg(target_os = "macos")]
pub fn get_text_field_info() -> Result<VoiceContext, String> {
    use accessibility_sys::{AXUIElementCopyAttributeValue, AXUIElementCreateSystemWide, AXUIElementRef};
    use core_foundation::base::{CFRelease, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use std::ptr;

    let mut context = VoiceContext::default();
    
    unsafe {
        let system_wide_element = AXUIElementCreateSystemWide();
        if system_wide_element.is_null() {
            return Err("Failed to create system-wide accessibility element".to_string());
        }

        // Get focused element
        let focused_attribute = CFString::new("AXFocusedUIElement");
        let mut focused_element: AXUIElementRef = ptr::null_mut();
        
        let result = AXUIElementCopyAttributeValue(
            system_wide_element,
            focused_attribute.as_concrete_TypeRef(),
            &mut focused_element as *mut _ as *mut _,
        );

        CFRelease(system_wide_element as *const _);

        if result != 0 || focused_element.is_null() {
            debug!("No focused element found or accessibility access denied");
            return Ok(context); // Return empty context if no focused element
        }

        // Try to get text value
        if let Ok(text) = get_element_attribute_string(focused_element, "AXValue") {
            context.full_text = text.clone();
            context.text_before_cursor = text; // For now, assume cursor is at end
        }

        // Try to get selected text
        if let Ok(selected) = get_element_attribute_string(focused_element, "AXSelectedText") {
            context.selected_text = selected;
        }

        // Try to get field role/type
        if let Ok(role) = get_element_attribute_string(focused_element, "AXRole") {
            context.field_type = Some(determine_field_type(&role));
            context.is_password_field = role.contains("SecureTextField") || role.contains("Password");
        }

        // Try to get field title/label
        if let Ok(title) = get_element_attribute_string(focused_element, "AXTitle") {
            context.field_label = Some(title);
        }

        // Try to get help text/placeholder
        if let Ok(help) = get_element_attribute_string(focused_element, "AXHelp") {
            context.field_hint = Some(help);
        }

        CFRelease(focused_element as *const _);
    }

    Ok(context)
}

#[cfg(target_os = "macos")]
unsafe fn get_element_attribute_string(element: accessibility_sys::AXUIElementRef, attribute: &str) -> Result<String, String> {
    use core_foundation::base::{CFRelease, TCFType};
    use core_foundation::string::{CFString, CFStringRef};
    use std::ptr;

    let attr_name = CFString::new(attribute);
    let mut value: *mut std::ffi::c_void = ptr::null_mut();
    
    let result = accessibility_sys::AXUIElementCopyAttributeValue(
        element,
        attr_name.as_concrete_TypeRef(),
        &mut value,
    );

    if result != 0 || value.is_null() {
        return Err(format!("Failed to get attribute {}", attribute));
    }

    // Try to convert to CFString
    let cf_string = CFString::wrap_under_create_rule(value as CFStringRef);
    let rust_string = cf_string.to_string();
    
    Ok(rust_string)
}

fn determine_field_type(role: &str) -> String {
    match role {
        r if r.contains("TextField") || r.contains("TextArea") => {
            if r.contains("Secure") || r.contains("Password") {
                "password".to_string()
            } else {
                "text".to_string()
            }
        }
        r if r.contains("SearchField") => "search".to_string(),
        r if r.contains("ComboBox") => "combobox".to_string(),
        _ => "text".to_string(),
    }
}

// Fallback implementations for non-macOS platforms
#[cfg(not(target_os = "macos"))]
pub fn get_active_window_info() -> Result<WindowInfo, String> {
    warn!("get_active_window_info not implemented for this platform");
    Ok(WindowInfo {
        window_title: "Unknown".to_string(),
        application_name: "Unknown".to_string(),
        bundle_id: "unknown".to_string(),
        process_name: "unknown".to_string(),
    })
}

#[cfg(not(target_os = "macos"))]
pub fn get_text_field_info() -> Result<VoiceContext, String> {
    warn!("get_text_field_info not implemented for this platform");
    Ok(VoiceContext::default())
}

/// Gather complete voice context including window and text field information
pub fn gather_voice_context() -> VoiceContext {
    let mut context = match get_text_field_info() {
        Ok(ctx) => ctx,
        Err(e) => {
            debug!("Failed to get text field info: {}", e);
            VoiceContext::default()
        }
    };

    // Get window information and update package name
    if let Ok(window_info) = get_active_window_info() {
        context.package_name = window_info.bundle_id.clone();
        debug!("Active window: {} ({})", window_info.application_name, window_info.bundle_id);
    } else {
        debug!("Failed to get active window info");
        context.package_name = "unknown".to_string();
    }

    context
}

/// Tauri command to gather voice context
#[tauri::command]
pub async fn gather_context() -> Result<VoiceContext, String> {
    let context = gather_voice_context();
    debug!("Gathered context: package={}, field_type={:?}, text_length={}", 
           context.package_name, context.field_type, context.full_text.len());
    Ok(context)
} 