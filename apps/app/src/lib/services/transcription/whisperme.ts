import { voiceFeedback, reportBudgetStatus, type BudgetStatus, type VoiceFailure } from '../voice-feedback';
import { settings } from '$lib/stores/settings.svelte';
import { llmRoutingOptions } from '$lib/constants/transcription/backend-provider-config';
import { invoke } from '@tauri-apps/api/core';
import { auth0Service } from '../auth0';
import { beginVoiceHistory, recordVoiceHistory, safeVoiceRecovery } from '../voice-history';
import { selectStyleProfile } from '../style-profile';
import { personalizationOptions, isNoticeOnlyResponse } from '../preference-contract';
import { receivePreferenceSuggestions, rememberVoiceApp } from '../preference-drafts';
import type { WhisperMeError } from '$lib/result';
import { Err, Ok, tryAsync, type Result } from 'wellcrafted/result';
import type {
	VoiceInputLlmProvider,
	VoiceInputTranscriptionProvider,
} from '$lib/constants/transcription';

export function createWhisperMeTranscriptionService() {
	return {
		async transcribe(
			audioBlob: Blob,
			options: {
				outputLanguage: string;
				prompt?: string;
				temperature?: string;
				transcriptionProvider: VoiceInputTranscriptionProvider;
				llmProvider: VoiceInputLlmProvider;
			} = {
				outputLanguage: 'auto',
				transcriptionProvider: 'groq_batch',
				llmProvider: 'groq_kimi_k2',
			},
		): Promise<Result<string, WhisperMeError>> {
			const historyId = crypto.randomUUID();
            const routing = llmRoutingOptions(settings.value['voiceInput.llmRouting'], options.llmProvider, settings.value['voiceInput.llmModel'], settings.value['voiceInput.reasoningEffort']);
			const usePreferences = settings.value['voiceInput.usePreferences'] === true;
			const diagnosticContext = settings.value['voiceInput.diagnosticContext'] === true;
			beginVoiceHistory(historyId, {
				transport: 'batch',
				transcriptionProvider: options.transcriptionProvider,
				llmProvider: routing.llmProvider, llmModel: routing.llmRouting === 'explicit' ? routing.llmModel : 'Server default', reasoningEffort: routing.reasoningEffort || 'default',
				mode: settings.value['voiceInput.mode'],
			});
			// Get authentication token
			const authToken = await auth0Service
				.getAccessToken()
				.catch((error: unknown) => {
					recordVoiceHistory(
						historyId,
						'auth.error',
						error instanceof Error ? error.message : String(error),
						{ status: 'failed' },
					);
					return null;
				});
			if (!authToken) {
				recordVoiceHistory(historyId, 'error', 'Sign-in required', {
					status: 'failed',
				});
				return Err({
					name: 'WhisperMeError',
					title: '🔐 Authentication Required',
					description: 'Please log in to use voice processing',
				});
			}

			// Convert blob to array buffer
			const { data: arrayBuffer, error: arrayBufferError } = await tryAsync({
				try: () => audioBlob.arrayBuffer(),
				mapError: (error) =>
					({
						name: 'WhisperMeError' as const,
						title: '📁 Audio Processing Failed',
						description: 'Failed to process audio file. Please try again.',
					}) satisfies WhisperMeError,
			});

			if (arrayBufferError) {
				recordVoiceHistory(historyId, 'error', arrayBufferError.description, {
					status: 'failed',
				});
				return Err(arrayBufferError);
			}

			// Convert to Uint8Array
			const audioData = new Uint8Array(arrayBuffer);

			// The native client captures context; the server cannot read this computer.
			const context = await invoke<{packageName: string; fullText?: string}>('gather_context').catch(() => undefined);
			if (context) rememberVoiceApp(context.packageName);
			const preferenceProfile = usePreferences && context ? selectStyleProfile(
				settings.value['voiceInput.styleProfiles'], settings.value['voiceInput.appCategories'], context.packageName,
			) : undefined;

			const progress = 'Processing audio and text. Up to two automatic retries per provider may occur; batch HTTP does not stream retry progress.';
            voiceFeedback.set({connection: '', retry: progress});
            recordVoiceHistory(historyId, 'processing.batch', progress, {status: 'processing'});
			// Call the backend
			const { data: response, error: backendError } = await tryAsync({
				try: () =>
					invoke<{
						diagnostics?: unknown;
						budget?: BudgetStatus;
						notice?: string;
						preferenceSuggestion?: unknown; preferenceSuggestions?: unknown;
						usage?: { summary: string; calls: unknown[] };
						success: boolean;
						transcription?: { text: string };
						finalText?: string;
						error?: string; failure?: VoiceFailure;
					}>('process_voice_with_backend', {
						audioData: Array.from(audioData),
						context,
						authToken,
						transcriptionProvider: options.transcriptionProvider,
						...llmRoutingOptions(settings.value['voiceInput.llmRouting'], options.llmProvider, settings.value['voiceInput.llmModel'], settings.value['voiceInput.reasoningEffort']),
						mode: settings.value['voiceInput.mode'],
						usePreferences, diagnosticContext, preferenceProfile,
						...personalizationOptions(settings.value, context?.packageName || 'unknown'),
					}),
				mapError: (error) =>
					({
						name: 'WhisperMeError' as const,
						title: '🔧 Backend Processing Failed',
						description: `Voice processing failed: ${error}`,
					}) satisfies WhisperMeError,
			});

            voiceFeedback.set({connection: '', retry: ''});
			if (backendError) {
				recordVoiceHistory(historyId, 'error', backendError.description, {
					status: 'failed',
				});
				return Err(backendError);
			}
			if (diagnosticContext && response.diagnostics)
					recordVoiceHistory(historyId, 'diagnostics.received', undefined, {diagnostics: response.diagnostics});
			const budgetWarning = reportBudgetStatus(response.budget || response.failure?.budget);
			if (budgetWarning) recordVoiceHistory(historyId, 'budget.warning', budgetWarning, {budgetWarning});
			if (response.notice) recordVoiceHistory(historyId, 'preference.notice', response.notice);
			if (receivePreferenceSuggestions(response, context?.packageName || 'unknown', settings.value['voiceInput.suggestPreferences'] === true))
				recordVoiceHistory(historyId, 'preference.draft', 'Writing rule draft ready for review in Voice settings. Save it to apply it.');
			if (response.usage)
				recordVoiceHistory(historyId, 'usage.updated', response.usage.summary, {
					usage: response.usage,
				});
			if (response.transcription?.text !== undefined)
				recordVoiceHistory(
					historyId,
					'transcript.final',
					response.transcription.text,
					{ transcript: response.transcription.text, finalTranscript: response.transcription.text, recovery: safeVoiceRecovery({...routing, mode: settings.value['voiceInput.mode']}) },
				);

            if (response.failure) recordVoiceHistory(historyId, 'provider.failure', response.error, {failure: response.failure});
			if (!response.success || typeof response.finalText !== 'string') {
				recordVoiceHistory(
					historyId,
					'error',
					response.error || 'Voice processing failed',
					{ status: 'failed' },
				);
				return Err({
					name: 'WhisperMeError',
					title: '❌ Voice Processing Failed',
					description: response.error || 'Unknown error occurred',
				});
			}

			// Return the transcribed text (prefer finalText, fallback to transcription)
			if (isNoticeOnlyResponse(response)) {
				recordVoiceHistory(historyId, 'preference.review', response.notice, {status: 'processed', result: ''});
				return Ok('');
			}
			const text = response.finalText;
			recordVoiceHistory(historyId, 'llm.result', response.finalText, {
				result: response.finalText ?? '',
				status: 'processed',
			});

			return Ok(text);
		},
	};
}
