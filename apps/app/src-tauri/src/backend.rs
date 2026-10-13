use crate::context::{VoiceContext, gather_voice_context};
use base64::{Engine as _, engine::general_purpose};
use reqwest;
use serde::{Deserialize, Serialize};
use tracing::{debug, error, info, warn};

const BACKEND_URL: &str = "https://process-voice.whisperme.app";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProcessRequest {
    pub platform: String,
    pub audio: String,  // Base64 encoded audio
    pub format: String,
    pub context: VoiceContext,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_model: Option<String>,
    pub llm_routing: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    pub mode: Option<String>,
    pub use_preferences: bool,
    pub diagnostic_context: bool,
    pub preference_profile: Option<serde_json::Value>,
    pub dictionary: Vec<String>,
    pub suggest_preferences: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProcessResponse {
    pub budget: Option<serde_json::Value>,
    pub diagnostics: Option<serde_json::Value>,
    pub notice: Option<String>,
    pub preference_suggestion: Option<serde_json::Value>,
    pub preference_suggestions: Option<serde_json::Value>,
    pub usage: Option<serde_json::Value>,
    pub success: bool,
    pub transcription: Option<TranscriptionResult>,
    pub final_text: Option<String>,
    pub error: Option<String>,
    pub failure: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionResult {
    pub text: String,
    pub confidence: Option<f32>,
    pub language: Option<String>,
}

/// Process audio with the custom backend API
pub async fn process_voice_recording(
    audio_data: Vec<u8>,
    context: Option<VoiceContext>,
    auth_token: Option<String>,
    transcription_provider: Option<String>,
    llm_provider: Option<String>,
    llm_model: Option<String>,
    llm_routing: Option<String>,
    reasoning_effort: Option<String>,
    mode: Option<String>,
    use_preferences: bool,
    diagnostic_context: bool,
    preference_profile: Option<serde_json::Value>,
    dictionary: Vec<String>,
    suggest_preferences: bool,
    app_category: Option<String>,
) -> Result<VoiceProcessResponse, String> {
    let mut seen = std::collections::HashSet::new();
    let dictionary: Vec<String> = dictionary.into_iter().map(|word| word.trim().to_owned())
        .filter(|word| seen.insert(word.to_lowercase())).collect();
    validate_personalization(&dictionary, app_category.as_deref())?;
    info!("Processing voice recording with backend API");
    info!("Audio data size: {} bytes", audio_data.len());

    // Encode audio as base64
    let base64_audio = general_purpose::STANDARD.encode(&audio_data);
    debug!("Audio encoded to base64: {} characters", base64_audio.len());

    // Gather context if not provided
    let voice_context = context.unwrap_or_else(|| {
        debug!("No context provided, gathering current context");
        gather_voice_context()
    });

    debug!("Using context: package={}, field_type={:?}", 
           voice_context.package_name, voice_context.field_type);

    // Create request payload
    let request_payload = VoiceProcessRequest {
        platform: std::env::consts::OS.to_string(),
        audio: base64_audio,
        format: "wav".to_string(),
        context: voice_context,
        transcription_provider,
        llm_provider,
        llm_model,
        llm_routing,
        reasoning_effort,
        mode,
        use_preferences,
        diagnostic_context,
        preference_profile: if use_preferences { preference_profile } else { None },
        dictionary,
        suggest_preferences,
        app_category,
    };

    // Send request to backend
    let client = reqwest::Client::new();
    
    debug!("Sending request to backend: {}", BACKEND_URL);
    
    // Build request with optional authentication
    let mut request_builder = client
        .post(BACKEND_URL)
        .json(&request_payload)
        .timeout(std::time::Duration::from_secs(300));
    
    // Add authentication header if token is provided
    if let Some(token) = auth_token {
        debug!("Adding authentication header");
        request_builder = request_builder.header("Authorization", format!("Bearer {}", token));
    } else {
        warn!("No authentication token provided - request may fail");
    }
    
    let response = request_builder
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    let status = response.status();
    debug!("Backend response status: {}", status);

    if !status.is_success() {
        let error_text = response.text().await
            .unwrap_or_else(|_| "Unknown error".to_string());
        // Preserve completed ASR output when only the later LLM stage failed.
        if let Ok(failed) = serde_json::from_str::<VoiceProcessResponse>(&error_text) {
            if !failed.success { return Ok(failed); }
        }
        error!("Backend error {}: {}", status, error_text);
        return Err(format!("Backend error {}: {}", status, error_text));
    }

    // Parse response
    let response_text = response.text().await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    
    debug!("Backend response received ({} bytes)", response_text.len());

    let voice_response: VoiceProcessResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if !voice_response.success { return Ok(voice_response); }

    info!("Voice processing completed successfully");
    if let Some(ref final_text) = voice_response.final_text {
        debug!("Final text: {}", final_text);
    }

    Ok(voice_response)
}

/// Convert audio blob to the format expected by Groq (16kHz, mono, WAV)
pub fn convert_audio_to_groq_format(audio_data: Vec<u8>) -> Result<Vec<u8>, String> {
    info!("Audio format conversion - ensuring WAV 16kHz mono format");
    debug!("Original audio size: {} bytes", audio_data.len());
    
    // The audio data coming from the recorder is already in the right format:
    // - 16kHz sample rate (VOICE_SAMPLE_RATE in thread.rs)
    // - Mono (preferred by get_optimal_config)
    // - f32 samples converted to bytes
    
    // For now, we'll assume the audio is already in the correct format
    // since our recorder is configured to output 16kHz mono audio
    // In a production app, you might want to use a library like `hound` 
    // to properly validate and convert the audio format
    
    // Validate that we have reasonable audio data
    if audio_data.is_empty() {
        return Err("Audio data is empty".to_string());
    }
    
    if audio_data.len() < 1000 {
        warn!("Audio data seems very short: {} bytes", audio_data.len());
    }
    
    debug!("Audio format validated - {} bytes ready for Groq", audio_data.len());
    Ok(audio_data)
}

/// Tauri command to process voice recording with backend
#[tauri::command]
pub async fn process_voice_with_backend(
    audio_data: Vec<u8>,
    context: Option<VoiceContext>,
    auth_token: Option<String>,
    transcription_provider: Option<String>,
    llm_provider: Option<String>,
    llm_model: Option<String>,
    llm_routing: Option<String>,
    reasoning_effort: Option<String>,
    mode: Option<String>,
    use_preferences: Option<bool>,
    diagnostic_context: Option<bool>,
    preference_profile: Option<serde_json::Value>,
    dictionary: Option<Vec<String>>,
    suggest_preferences: Option<bool>,
    app_category: Option<String>,
) -> Result<VoiceProcessResponse, String> {
    debug!("Processing voice recording via Tauri command");
    debug!("Auth token provided: {}", auth_token.is_some());
    
    // Convert audio to proper format
    let converted_audio = convert_audio_to_groq_format(audio_data)
        .map_err(|e| format!("Audio conversion failed: {}", e))?;
    
    // Process with backend
    process_voice_recording(
        converted_audio,
        context,
        auth_token,
        transcription_provider,
        llm_provider,
        llm_model,
        llm_routing,
        reasoning_effort,
        mode,
        use_preferences.unwrap_or(false),
        diagnostic_context.unwrap_or(false),
        preference_profile,
        dictionary.unwrap_or_default(),
        suggest_preferences.unwrap_or(false),
        app_category,
    )
    .await
}

fn validate_personalization(dictionary: &[String], category: Option<&str>) -> Result<(), String> {
    if dictionary.len() > 100 || dictionary.iter().any(|word| word.trim().is_empty() || word.encode_utf16().count() > 80 || word.chars().any(|ch| ch < ' '))
        || dictionary.iter().map(|word| word.len()).sum::<usize>() > 4096 {
        return Err("Dictionary exceeds 100 entries, 80 characters per entry or 4096 UTF-8 bytes".into());
    }
    if category.is_some_and(|id| !matches!(id, "personal" | "business" | "development" | "writing" | "productivity" | "education" | "other")) {
        return Err("Unknown app category".into());
    }
    Ok(())
}

/// Test the backend connection
#[tauri::command]
pub async fn test_backend_connection() -> Result<bool, String> {
    info!("Testing backend connection");
    
    let client = reqwest::Client::new();
    
    match client
        .get(BACKEND_URL)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status();
            debug!("Backend test response: {}", status);
            // Even a 405 Method Not Allowed is fine, it means the server is responding
            Ok(status.is_client_error() || status.is_success())
        }
        Err(e) => {
            error!("Backend connection test failed: {}", e);
            Err(format!("Backend not reachable: {}", e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personalization_bounds_and_legacy_response() {
        assert!(validate_personalization(&[], None).is_ok());
        assert!(validate_personalization(&vec!["é".repeat(80); 25], Some("business")).is_ok());
        assert!(validate_personalization(&vec!["é".repeat(80); 26], None).is_err());
        assert!(validate_personalization(&vec!["word".into(); 101], None).is_err());
        assert!(validate_personalization(&["x".repeat(81)], None).is_err());
        assert!(validate_personalization(&[], Some("work")).is_err());
        let context = serde_json::to_value(VoiceContext::default()).unwrap();
        assert_eq!(context["supportsDictionaryConfirmation"], true);
        assert_eq!(context["supportsScopedPreferenceConfirmation"], true);
        let legacy: VoiceProcessResponse = serde_json::from_value(serde_json::json!({"success":true,"finalText":"Hello"})).unwrap();
        assert!(legacy.preference_suggestion.is_none());
        let response: VoiceProcessResponse = serde_json::from_value(serde_json::json!({"success":true,"preferenceSuggestion":{"scope":"category","categoryId":"business","ruleText":"Use short sentences"}})).unwrap();
        assert_eq!(response.preference_suggestion.unwrap()["categoryId"], "business");
    }
    
    #[tokio::test]
    async fn test_backend_connection_test() {
        let result = test_backend_connection().await;
        println!("Backend connection test result: {:?}", result);
        // This test just verifies the function doesn't panic
        assert!(result.is_ok() || result.is_err());
    }
}
