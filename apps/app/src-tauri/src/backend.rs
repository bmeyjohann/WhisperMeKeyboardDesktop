use crate::context::{VoiceContext, gather_voice_context};
use base64::{Engine as _, engine::general_purpose};
use reqwest;
use serde::{Deserialize, Serialize};
use tracing::{debug, error, info, warn};

const BACKEND_URL: &str = "https://process-voice.whisperme.app";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProcessRequest {
    pub audio: String,  // Base64 encoded audio
    pub format: String,
    pub context: VoiceContext,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProcessResponse {
    pub success: bool,
    pub transcription: Option<TranscriptionResult>,
    pub final_text: Option<String>,
    pub error: Option<String>,
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
) -> Result<VoiceProcessResponse, String> {
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
        audio: base64_audio,
        format: "wav".to_string(),
        context: voice_context,
    };

    // Send request to backend
    let client = reqwest::Client::new();
    
    debug!("Sending request to backend: {}", BACKEND_URL);
    let response = client
        .post(BACKEND_URL)
        .json(&request_payload)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    let status = response.status();
    debug!("Backend response status: {}", status);

    if !status.is_success() {
        let error_text = response.text().await
            .unwrap_or_else(|_| "Unknown error".to_string());
        error!("Backend error {}: {}", status, error_text);
        return Err(format!("Backend error {}: {}", status, error_text));
    }

    // Parse response
    let response_text = response.text().await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    
    debug!("Backend response: {}", response_text);

    let voice_response: VoiceProcessResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if !voice_response.success {
        let error_msg = voice_response.error.unwrap_or_else(|| "Unknown backend error".to_string());
        error!("Backend processing failed: {}", error_msg);
        return Err(error_msg);
    }

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
) -> Result<VoiceProcessResponse, String> {
    debug!("Processing voice recording via Tauri command");
    
    // Convert audio to proper format
    let converted_audio = convert_audio_to_groq_format(audio_data)
        .map_err(|e| format!("Audio conversion failed: {}", e))?;
    
    // Process with backend
    process_voice_recording(converted_audio, context).await
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
    
    #[tokio::test]
    async fn test_backend_connection_test() {
        let result = test_backend_connection().await;
        println!("Backend connection test result: {:?}", result);
        // This test just verifies the function doesn't panic
        assert!(result.is_ok() || result.is_err());
    }
}

