use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Manager, Emitter};
use serde_json::{json, Value};
use tiny_http::{Server, Response, Header};
use url::Url;

// Global state for OAuth callback server and deep link data
lazy_static::lazy_static! {
    static ref OAUTH_SERVER: Arc<Mutex<Option<OAuthServer>>> = Arc::new(Mutex::new(None));
    static ref DEEP_LINK_DATA: Arc<Mutex<Option<CallbackData>>> = Arc::new(Mutex::new(None));
}

struct OAuthServer {
    server_handle: Option<thread::JoinHandle<()>>,
    callback_data: Arc<Mutex<Option<CallbackData>>>,
}

#[derive(Debug, Clone)]
struct CallbackData {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// Get stored authentication tokens from secure storage
#[tauri::command]
pub async fn get_stored_tokens(app: AppHandle) -> Result<Option<String>, String> {
    // For now, we'll use a simple file-based storage
    // In production, you should use platform-specific secure storage
    let app_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    
    let token_file = app_dir.join("auth_tokens.json");
    
    if token_file.exists() {
        match std::fs::read_to_string(&token_file) {
            Ok(content) => {
                // Basic validation that it's valid JSON
                match serde_json::from_str::<Value>(&content) {
                    Ok(_) => Ok(Some(content)),
                    Err(_) => {
                        // Invalid JSON, remove the file
                        let _ = std::fs::remove_file(&token_file);
                        Ok(None)
                    }
                }
            }
            Err(_) => Ok(None),
        }
    } else {
        Ok(None)
    }
}

/// Store authentication tokens securely
#[tauri::command]
pub async fn store_tokens(app: AppHandle, tokens: String) -> Result<(), String> {
    let app_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    
    // Ensure the directory exists
    std::fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    
    let token_file = app_dir.join("auth_tokens.json");
    
    std::fs::write(&token_file, tokens)
        .map_err(|e| format!("Failed to store tokens: {}", e))?;
    
    Ok(())
}

/// Clear stored authentication tokens
#[tauri::command]
pub async fn clear_stored_tokens(app: AppHandle) -> Result<(), String> {
    let app_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    
    let token_file = app_dir.join("auth_tokens.json");
    
    if token_file.exists() {
        std::fs::remove_file(&token_file)
            .map_err(|e| format!("Failed to clear tokens: {}", e))?;
    }
    
    Ok(())
}

/// Start OAuth callback server
#[tauri::command]
pub async fn start_oauth_server(port: u16) -> Result<(), String> {
    let mut server_guard = OAUTH_SERVER.lock()
        .map_err(|_| "Failed to acquire server lock")?;
    
    // Stop any existing server
    if let Some(oauth_server) = server_guard.take() {
        // The old server will be dropped and cleaned up
        drop(oauth_server);
    }
    
    let callback_data = Arc::new(Mutex::new(None));
    let callback_data_clone = callback_data.clone();
    
    let server_handle = thread::spawn(move || {
        let address = format!("127.0.0.1:{}", port);
        let server = match Server::http(&address) {
            Ok(server) => server,
            Err(e) => {
                eprintln!("Failed to start OAuth server: {}", e);
                return;
            }
        };
        
        println!("OAuth callback server started on {}", address);
        
        for request in server.incoming_requests() {
            let url = format!("http://127.0.0.1:{}{}", port, request.url());
            
            if let Ok(parsed_url) = Url::parse(&url) {
                if parsed_url.path() == "/callback" {
                    let query_pairs: HashMap<String, String> = parsed_url
                        .query_pairs()
                        .into_owned()
                        .collect();
                    
                    let callback = CallbackData {
                        code: query_pairs.get("code").cloned(),
                        state: query_pairs.get("state").cloned(),
                        error: query_pairs.get("error").cloned(),
                    };
                    
                    println!("OAuth callback received: code={}, state={}, error={}", 
                        callback.code.as_deref().unwrap_or("None"),
                        callback.state.as_deref().unwrap_or("None"),
                        callback.error.as_deref().unwrap_or("None")
                    );
                    
                    // Store the callback data
                    if let Ok(mut data) = callback_data_clone.lock() {
                        *data = Some(callback.clone());
                        println!("OAuth callback data stored successfully");
                    }
                    
                    // Send a response to the browser
                    let response_html = if callback.error.is_some() {
                        "<html><body><h1>Authentication Failed</h1><p>You can close this window.</p></body></html>"
                    } else if callback.code.is_some() {
                        "<html><body><h1>Authentication Successful</h1><p>You can close this window and return to the app.</p></body></html>"
                    } else {
                        "<html><body><h1>Authentication Error</h1><p>Missing authorization code.</p></body></html>"
                    };
                    
                    let response = Response::from_string(response_html)
                        .with_header(Header::from_bytes(&b"Content-Type"[..], &b"text/html"[..]).unwrap());
                    
                    let _ = request.respond(response);
                    
                    // Break the loop after handling the callback
                    break;
                }
            }
            
            // For any other request, send a 404
            let response = Response::from_string("Not Found").with_status_code(404);
            let _ = request.respond(response);
        }
        
        println!("OAuth callback server stopped");
    });
    
    *server_guard = Some(OAuthServer {
        server_handle: Some(server_handle),
        callback_data,
    });
    
    Ok(())
}

/// Stop OAuth callback server
#[tauri::command]
pub async fn stop_oauth_server() -> Result<(), String> {
    let mut server_guard = OAUTH_SERVER.lock()
        .map_err(|_| "Failed to acquire server lock")?;
    
    if let Some(oauth_server) = server_guard.take() {
        // The server will be dropped and cleaned up
        drop(oauth_server);
    }
    
    Ok(())
}

/// Get OAuth callback data (polling-based approach)
#[tauri::command]
pub async fn get_oauth_callback() -> Result<Option<String>, String> {
    // First check for deep link data
    if let Ok(mut deep_link_guard) = DEEP_LINK_DATA.lock() {
        if let Some(callback_data) = deep_link_guard.take() {
            let result = json!({
                "code": callback_data.code,
                "state": callback_data.state,
                "error": callback_data.error
            });
            let json_string = result.to_string();
            println!("Deep link callback data retrieved (debug): {:?}", result);
            println!("Deep link callback data retrieved (JSON string): {}", json_string);
            return Ok(Some(json_string));
        }
    }
    
    // Then check for localhost server data
    let server_guard = OAUTH_SERVER.lock()
        .map_err(|_| "Failed to acquire server lock")?;
    
    if let Some(oauth_server) = &*server_guard {
        if let Ok(mut callback_data_guard) = oauth_server.callback_data.lock() {
            if let Some(callback_data) = callback_data_guard.take() { // Use take() to consume the data
                let result = json!({
                    "code": callback_data.code,
                    "state": callback_data.state,
                    "error": callback_data.error
                });
                let json_string = result.to_string();
                println!("OAuth callback data retrieved (debug): {:?}", result);
                println!("OAuth callback data retrieved (JSON string): {}", json_string);
                return Ok(Some(json_string));
            }
        }
    }
    
    Ok(None)
}

/// JavaScript logging command to send logs to Rust terminal
#[tauri::command]
pub async fn js_log(level: String, message: String) -> Result<(), String> {
    println!("[JS-{}] {}", level.to_uppercase(), message);
    Ok(())
}

/// Listen for OAuth callback (event-based approach - simplified for now)
#[tauri::command]
pub async fn listen_oauth_callback() -> Result<(), String> {
    // This is a simplified implementation
    // In a real implementation, you'd want to set up proper event listeners
    // For now, the frontend can poll using get_oauth_callback
    Ok(())
}

/// Handle deep link URL for OAuth callback
#[tauri::command]
pub async fn handle_deep_link(url: String) -> Result<(), String> {
    println!("Deep link received: {}", url);
    
    if let Ok(parsed_url) = Url::parse(&url) {
        if parsed_url.scheme() == "whisperme" && parsed_url.path() == "/auth/callback" {
            let query_pairs: HashMap<String, String> = parsed_url
                .query_pairs()
                .into_owned()
                .collect();
            
            let callback_data = CallbackData {
                code: query_pairs.get("code").cloned(),
                state: query_pairs.get("state").cloned(),
                error: query_pairs.get("error").cloned(),
            };
            
            println!("Deep link OAuth callback: code={}, state={}, error={}", 
                callback_data.code.as_deref().unwrap_or("None"),
                callback_data.state.as_deref().unwrap_or("None"),
                callback_data.error.as_deref().unwrap_or("None")
            );
            
            // Store the callback data
            if let Ok(mut data) = DEEP_LINK_DATA.lock() {
                *data = Some(callback_data);
                println!("Deep link callback data stored successfully");
            }
        }
    }
    
    Ok(())
}

/// Handle deep link URL for OAuth callback (with app handle for events)
#[tauri::command]
pub async fn handle_deep_link_with_app(app: AppHandle, url: String) -> Result<(), String> {
    println!("Deep link received: {}", url);
    
    // Emit event to frontend
    if let Err(e) = app.emit("deep-link", &url) {
        eprintln!("Failed to emit deep-link event: {}", e);
    }
    
    // Also handle via polling mechanism
    handle_deep_link(url).await
} 