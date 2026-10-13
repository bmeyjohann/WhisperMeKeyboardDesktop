import type { ElevenLabsModel } from '$lib/constants/transcription';
import type { WhisperMeError } from '$lib/result';
import type { Settings } from '$lib/settings';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { ElevenLabsClient } from 'elevenlabs';

export function createElevenLabsTranscriptionService() {
	return {
		transcribe: async (
			audioBlob: Blob,
			options: {
				prompt: string;
				temperature: string;
				outputLanguage: Settings['transcription.outputLanguage'];
				apiKey: string;
				modelName: (string & {}) | ElevenLabsModel['name'];
			},
		): Promise<Result<string, WhisperMeError>> => {
			if (!options.apiKey) {
				return Err({
					name: 'WhisperMeError',
					title: '🔑 API Key Required',
					description:
						'Please enter your ElevenLabs API key in settings to use speech-to-text transcription.',
					action: {
						type: 'link',
						label: 'Add API key',
						goto: '/settings/transcription',
					},
				} satisfies WhisperMeError);
			}

			try {
				const client = new ElevenLabsClient({
					apiKey: options.apiKey,
				});

				// Check file size
				const blobSizeInMb = audioBlob.size / (1024 * 1024);
				const MAX_FILE_SIZE_MB = 1000; // ElevenLabs allows files up to 1GB

				if (blobSizeInMb > MAX_FILE_SIZE_MB) {
					return Err({
						name: 'WhisperMeError',
						title: '📁 File Size Too Large',
						description: `Your audio file (${blobSizeInMb.toFixed(1)}MB) exceeds the ${MAX_FILE_SIZE_MB}MB limit. Please use a smaller file or compress the audio.`,
					} satisfies WhisperMeError);
				}

				// Use the client's speechToText functionality
				const transcription = await client.speechToText.convert({
					file: audioBlob,
					model_id: options.modelName,
					// Map outputLanguage if not set to 'auto'
					language_code:
						options.outputLanguage !== 'auto'
							? options.outputLanguage
							: undefined,
					tag_audio_events: false,
					diarize: true,
				});

				// Return the transcribed text
				return Ok(transcription.text.trim());
			} catch (error) {
				return Err({
					name: 'WhisperMeError',
					title: '🔧 Transcription Failed',
					description:
						'Unable to complete the transcription using ElevenLabs. This may be due to a service issue or unsupported audio format. Please try again.',
					action: { type: 'more-details', error },
				} satisfies WhisperMeError);
			}
		},
	};
}

export type ElevenLabsTranscriptionService = ReturnType<
	typeof createElevenLabsTranscriptionService
>;

export const ElevenlabsTranscriptionServiceLive =
	createElevenLabsTranscriptionService();
