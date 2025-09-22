import { invoke } from '@tauri-apps/api/core';
import { auth0Service } from '../auth0';
import type { WhisperingError } from '$lib/result';
import { Err, Ok, tryAsync, type Result } from 'wellcrafted/result';
import type { Settings } from '$lib/settings';

export function createWhisperMeTranscriptionService() {
	return {
		async transcribe(
			audioBlob: Blob,
			options: {
				outputLanguage: string;
				prompt?: string;
				temperature?: string;
			} = { outputLanguage: 'auto' }
		): Promise<Result<string, WhisperingError>> {
			// Get authentication token
			const authToken = await auth0Service.getAccessToken();
			if (!authToken) {
				return Err({
					name: 'WhisperingError',
					title: '🔐 Authentication Required',
					description: 'Please log in to use voice processing'
				});
			}

			// Convert blob to array buffer
			const { data: arrayBuffer, error: arrayBufferError } = await tryAsync({
				try: () => audioBlob.arrayBuffer(),
				mapError: (error) => ({
					name: 'WhisperingError' as const,
					title: '📁 Audio Processing Failed',
					description: 'Failed to process audio file. Please try again.',
				}) satisfies WhisperingError,
			});

			if (arrayBufferError) return Err(arrayBufferError);

			// Convert to Uint8Array
			const audioData = new Uint8Array(arrayBuffer);

			// Gather context (optional - backend will gather if not provided)
			const context = undefined; // Let backend gather context

			// Call the backend
			const { data: response, error: backendError } = await tryAsync({
				try: () => invoke<{
					success: boolean;
					transcription?: { text: string };
					finalText?: string;
					error?: string;
				}>('process_voice_with_backend', {
					audioData: Array.from(audioData),
					context,
					authToken
				}),
				mapError: (error) => ({
					name: 'WhisperingError' as const,
					title: '🔧 Backend Processing Failed',
					description: `Voice processing failed: ${error}`,
				}) satisfies WhisperingError,
			});

			if (backendError) return Err(backendError);

			if (!response.success) {
				return Err({
					name: 'WhisperingError',
					title: '❌ Voice Processing Failed',
					description: response.error || 'Unknown error occurred'
				});
			}

			// Return the transcribed text (prefer finalText, fallback to transcription)
			const text = response.finalText || response.transcription?.text || '';
			
			return Ok(text);
		}
	};
} 