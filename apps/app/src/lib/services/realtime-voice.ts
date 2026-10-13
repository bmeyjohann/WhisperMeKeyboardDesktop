import { resumeVoiceTranscript } from './resume-voice';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { settings } from '$lib/stores/settings.svelte';
import { auth0Service } from './auth0';
import { toast } from '$lib/toast';
import { platform } from '@tauri-apps/plugin-os';
import { compatibleLlmModel, llmRoutingOptions } from '$lib/constants/transcription/backend-provider-config';
import { beginVoiceHistory, recordVoiceHistory, historySession, initVoiceHistory, safeVoiceRecovery } from './voice-history';
import { voiceFeedback, connectionText, providerRetryText, reportBudgetStatus, type BudgetStatus, type VoiceFailure } from './voice-feedback';
import { selectStyleProfile } from './style-profile';
import { personalizationOptions, isNoticeOnlyResponse } from './preference-contract';
import { receivePreferenceSuggestions, rememberVoiceApp } from './preference-drafts';
import {
	applyEditorWindow,
	createEditorWindow,
	type EditorSnapshot,
	type EditorWindow,
	type ContextWindow,
} from './editor-window';

type Phase = 'idle' | 'connecting' | 'recording' | 'processing';
type Snapshot = EditorSnapshot & {
	captureTimings?: Record<string, number>;
	helperTiming?: {
		reused: boolean;
		lockMs: number;
		readyMs: number;
		totalMs: number;
	};
};
let phase: Phase = 'idle';
let ending = false;
let recoveryBusy = false;
const isIdle = () => phase === 'idle';
export const isVoiceSessionActive = () => !isIdle();
let id = '';
let stream: MediaStream | undefined;
let audio: AudioContext | undefined;
let worklet: AudioWorkletNode | undefined;
let unlisten: UnlistenFn | undefined;
let transcript = '';
let assistant = '';
let statusText = '';
let connectionStatus = '';
let retryText = '';
let budgetWarning = '';
let finalResult: string | undefined;
let revision = 0;
let target: Snapshot | undefined;
let targetWindow: EditorWindow | undefined;
let contextRequests = new Set<string>();
let targetError = '';
let finalTranscriptReceived = false;
let retryPayload: Record<string, unknown> | undefined;

// Manual continuation always returns a copyable result. No saved field identity is reused.
export async function retryVoiceProcessing(sessionId: string) {
    if (!isIdle() || ending) return;
    // Reserve immediately: two clicks must not race history initialization/authentication.
    phase = 'processing';
    recoveryBusy = true;
    try {
        await initVoiceHistory();
        const session = historySession(sessionId);
        if (!session?.finalTranscript || !session.recovery || session.status === 'copy_ready') return;
        recordVoiceHistory(sessionId, 'retry.started', 'Formatting the complete transcript without editor context. Copy the result when ready.', {status: 'processing'});
        const token = await auth0Service.getVoiceAccessToken();
        if (!token) throw new Error('Sign in before processing again.');
        const {version: _, ...routing} = safeVoiceRecovery(session.recovery);
        const result = await resumeVoiceTranscript(sessionId, settings.value['voiceInput.endpoint'], token, {
            ...routing, platform: platform(), transcript: session.finalTranscript, usePreferences: false, diagnosticContext: false,
            context: {fullText: '', textBeforeCursor: '', textAfterCursor: '', selectedText: '', cursorPosition: 0, packageName: 'unknown', isPasswordField: false, isRichEditor: false, locale: navigator.language},
        });
        if (result.usage) {
            const previous = historySession(sessionId)?.usage;
            recordVoiceHistory(sessionId, 'usage.retry', result.usage.summary, {usage: {
                summary: `${previous?.summary || 'Earlier usage unavailable'}; retry: ${result.usage.summary}`,
                calls: [...(previous?.calls || []), ...result.usage.calls],
            }});
        }
        if (result.failure) recordVoiceHistory(sessionId, 'provider.failure', result.error, {failure: result.failure});
        if (!result.success || typeof result.finalText !== 'string') throw new Error(result.error || 'Processing failed');
        recordVoiceHistory(sessionId, 'llm.result', result.finalText, {result: result.finalText, status: 'copy_ready', failure: undefined});
        toast.success({title: 'Recovered text ready to copy', description: 'No editor was changed. Copy the result from Transcripts.', action: {type: 'button', label: 'Copy result', onClick: () => writeText(result.finalText!)}});
    } catch (error) {
        recordVoiceHistory(sessionId, 'retry.failed', String(error), {status: 'failed'});
        toast.error({title: 'Retry did not complete', description: String(error)});
    } finally { phase = 'idle'; recoveryBusy = false; voiceFeedback.set({connection: '', retry: ''}); }
}
let sendQueue = Promise.resolve();
let stopRequested = false;
let connectionReady: Promise<void> = Promise.resolve();
let bufferedBytes = 0;
let cancelSignIn: (() => void) | undefined;
let captureStopped: Promise<void> | undefined;
let preparedAudio: Promise<AudioContext> | undefined;
let sourceNode: MediaStreamAudioSourceNode | undefined;
let muteNode: GainNode | undefined;

// Reuse the graph runtime and loaded processor, never an idle microphone stream.
function prepareAudio(): Promise<AudioContext> {
	if (!preparedAudio) {
		const context = new AudioContext({
			sampleRate: 16000,
			latencyHint: 'interactive',
		});
		preparedAudio = (async () => {
			try {
				if (context.sampleRate !== 16000)
					throw new Error('This audio device cannot provide 16 kHz recording');
				await Promise.all([
					context.suspend(),
					context.audioWorklet.addModule('/voice-pcm-worklet.js'),
				]);
				return context;
			} catch (error) {
				await context.close().catch(() => undefined);
				preparedAudio = undefined;
				throw error;
			}
		})();
	}
	return preparedAudio;
}

function stopCapture(): Promise<void> {
	if (captureStopped) return captureStopped;
	// Stop hardware capture before any network or sign-in wait. Flush while the
	// audio render thread is running, then suspend after its acknowledgement.
	for (const track of stream?.getTracks() ?? []) track.stop();
	captureStopped = (async () => {
		if (!worklet) return;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error('Microphone did not flush')),
				2000,
			);
			flushed = () => {
				clearTimeout(timer);
				resolve();
			};
			worklet?.port.postMessage('flush');
		});
		await audio?.suspend();
	})();
	return captureStopped;
}

async function signInForRecording(sessionId: string): Promise<string> {
	recordVoiceHistory(sessionId, 'auth.sign_in_required');
	if (phase === 'recording') void toggleRealtimeVoice();
	await stopCapture();
	if (id !== sessionId || ending || isIdle()) throw new Error('Cancelled');
	assistant =
		'Recording stopped and retained. Sign in here or in Settings to finish it, or cancel to discard.';
	void render();
	return new Promise((resolve, reject) => {
		let initialNotification = true;
		let unsubscribe = () => {};
		const finish = () => {
			unsubscribe();
			clearTimeout(timer);
			cancelSignIn = undefined;
		};
		const timer = setTimeout(() => {
			assistant =
				'Your recording is still retained. Sign in to finish, or cancel to discard.';
			void render();
		}, 300000);
		cancelSignIn = () => {
			finish();
			reject(new Error('Cancelled'));
		};
		unsubscribe = auth0Service.accessToken.subscribe((token) => {
			// Ignore only the store's immediate snapshot, which may be the rejected
			// token. A subsequent sign-in from either Settings or this prompt resumes.
			if (initialNotification) {
				initialNotification = false;
				return;
			}
			if (token && id === sessionId && !ending) {
				finish();
				resolve(token);
			}
		});
		toast.error({
			title: 'Sign in to finish your recording',
			description: 'Your audio stays in memory while this app remains open.',
			action: {
				type: 'button',
				label: 'Sign in and retry',
				onClick: () => {
					void auth0Service.login();
				},
			},
		});
	});
}
let flushed: (() => void) | undefined;
let ready: (() => void) | undefined;
let rejectReady: ((error: Error) => void) | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
let startupTimeout: ReturnType<typeof setTimeout> | undefined;
let overlayTimer: ReturnType<typeof setInterval> | undefined;

export function usesRealtimeVoice() {
	return (
		phase !== 'idle' ||
		(settings.value['transcription.selectedTranscriptionService'] ===
			'WhisperMe' &&
			settings.value['voiceInput.transcriptionProvider'] !== 'groq_batch')
	);
}
const render = () => {
	voiceFeedback.set({connection: connectionStatus, retry: retryText, budget: budgetWarning});
	return invoke('voice_overlay_update', {
		data: { transcript, assistant, statusText, connectionStatus, retryText, budgetWarning, phase, result: finalResult },
	}).catch(() => undefined);
};
const send = (message: object, sessionId = id) =>
	invoke<void>('voice_stream_send', {
		id: sessionId,
		message: JSON.stringify(message),
	});

async function provideContext(
	event: { requestId?: unknown; beforeChars?: unknown; afterChars?: unknown },
	sessionId: string,
) {
	if (id !== sessionId || ending || phase !== 'processing') return;
	const requestId = event.requestId;
	if (typeof requestId !== 'string' || !requestId || requestId.length > 100)
		throw new Error('The service requested an invalid context window.');
	if (contextRequests.has(requestId)) return;
	if (contextRequests.size >= 2)
		throw new Error('The service exceeded the context-request limit.');
	contextRequests.add(requestId);
	statusText = 'Gathering more context…';
	void render();
	try {
		if (!target || !targetWindow)
			throw new Error('No verified editor context is available.');
		if (
			typeof event.beforeChars !== 'number' ||
			typeof event.afterChars !== 'number'
		)
			throw new Error('The service requested an invalid context window.');
		const expanded = createEditorWindow(
			target,
			event.beforeChars,
			event.afterChars,
		);
		if (expanded.start > targetWindow.start || expanded.end < targetWindow.end)
			throw new Error(
				'Additional context must preserve the existing editing window.',
			);
		if (
			expanded.start === targetWindow.start &&
			expanded.end === targetWindow.end
		)
			throw new Error(
				'No additional context is available within the supported window.',
			);
		targetWindow = expanded;
		if (retryPayload) retryPayload.context = {...(retryPayload.context as Record<string, unknown>), ...expanded.context};
		recordVoiceHistory(
			sessionId,
			'context.provided',
			'Provided more context from the originally captured field.',
		);
		await send(
			{
				type: 'context.provide',
				payload: { requestId, context: expanded.context },
			},
			sessionId,
		);
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: 'Additional context is unavailable.';
		recordVoiceHistory(sessionId, 'context.unavailable', message);
		await send(
			{ type: 'context.provide', payload: { requestId, error: message } },
			sessionId,
		);
	}
}

async function cleanup() {
	cancelSignIn?.();
	clearTimeout(timeout);
	clearTimeout(startupTimeout);
	clearInterval(overlayTimer);
	retryText = '';
	connectionStatus = '';
	voiceFeedback.set({connection: '', retry: ''});
	for (const track of stream?.getTracks() ?? []) track.stop();
	worklet?.disconnect();
	sourceNode?.disconnect();
	muteNode?.disconnect();
	if (worklet) worklet.port.onmessage = null;
	unlisten?.();
	unlisten = undefined;
	await audio?.suspend().catch(() => {
		preparedAudio = undefined;
	});
	stream = undefined;
	audio = undefined;
	worklet = undefined;
	sourceNode = undefined;
	muteNode = undefined;
	await invoke('voice_stream_close', { id }).catch(() => undefined);
}
async function fail(error: unknown, sessionId = id) {
	if (isIdle() || ending || sessionId !== id) return;
	ending = true;
	const description = String(error instanceof Error ? error.message : error);
	recordVoiceHistory(sessionId, 'error', description, {
		status: 'failed',
		transcript,
	});
	rejectReady?.(new Error(description));
	await cleanup();
	assistant = description;
	phase = 'idle';
	await render();
	const savedTranscript = transcript;
	toast.error({
		title: 'Voice session stopped',
		description,
		action: {
			type: 'button',
			label: 'Copy transcript',
			onClick: () => writeText(savedTranscript),
		},
	});
	phase = 'idle';
	ending = false;
}
export async function cancelRealtimeVoice() {
    if (recoveryBusy) return;
	if (isIdle() || ending) return;
	ending = true;
	finalTranscriptReceived = false;
	retryPayload = undefined;
	recordVoiceHistory(id, 'cancelled', undefined, {
		status: 'cancelled',
		transcript,
	});
	rejectReady?.(new Error('Cancelled'));
	await send({ type: 'session.cancel' }).catch(() => undefined);
	await cleanup();
	await invoke('hide_recording_overlay').catch(() => undefined);
	phase = 'idle';
	ending = false;
}

export async function toggleRealtimeVoice() {
	if (ending) return;
	if (phase === 'connecting') {
		stopRequested = true;
		if (worklet) await stopCapture().catch((error) => fail(error));
		return;
	}
	if (phase === 'processing') return;
	if (phase === 'recording') {
		const sessionId = id;
		phase = 'processing';
		statusText = 'Formatting…';
		recordVoiceHistory(sessionId, 'recording.stopped', undefined, {
			status: 'processing',
			transcript,
		});
		try {
			await stopCapture();
			if (sessionId !== id || ending || isIdle()) return;
			await connectionReady;
			await sendQueue;
			if (sessionId !== id || ending || isIdle()) return;
			await send({ type: 'session.stop' });
			if (id !== sessionId || ending || isIdle()) return;
			await invoke('show_processing_overlay');
			await render();
			timeout = setTimeout(
				() => void fail(new Error('Final processing timed out'), sessionId),
				160000,
			);
		} catch (error) {
			await fail(error, sessionId);
		}
		return;
	}
	phase = 'connecting';
	finalTranscriptReceived = false;
	retryPayload = undefined;
	id = crypto.randomUUID();
	beginVoiceHistory(id, {
		transport: 'realtime',
		transcriptionProvider: settings.value['voiceInput.transcriptionProvider'],
		transcriptionModel:
			settings.value['voiceInput.transcriptionModel'] || 'Provider default',
		llmProvider: settings.value['voiceInput.llmRouting'] === 'explicit' ? settings.value['voiceInput.llmProvider'] : 'Server default',
		llmModel: settings.value['voiceInput.llmRouting'] === 'explicit' ? compatibleLlmModel(
			settings.value['voiceInput.llmProvider'],
			settings.value['voiceInput.llmModel'],
		) : 'Server default',
		reasoningEffort: llmRoutingOptions(settings.value['voiceInput.llmRouting'], settings.value['voiceInput.llmProvider'], settings.value['voiceInput.llmModel'], settings.value['voiceInput.reasoningEffort']).reasoningEffort || 'default',
		mode: settings.value['voiceInput.mode'],
	});
	const sessionId = id;
	const usePreferences = settings.value['voiceInput.usePreferences'] === true;
	const diagnosticContext = settings.value['voiceInput.diagnosticContext'] === true;
	const profiles = settings.value['voiceInput.styleProfiles'] ?? [];
	const categories = settings.value['voiceInput.appCategories'] ?? [];
	const personalizationSettings = {...settings.value};
	const startupAt = performance.now();
	const startupMark = (stage: string) => {
		if (id === sessionId && !ending && !isIdle())
			recordVoiceHistory(
				sessionId,
				`startup.${stage}`,
				`${Math.round(performance.now() - startupAt)} ms after shortcut`,
			);
	};
	transcript = '';
	assistant = '';
	statusText = '';
	retryText = '';
	connectionStatus = connectionText();
	budgetWarning = '';
	revision = 0;
	target = undefined;
	targetWindow = undefined;
	contextRequests = new Set();
	targetError = '';
	finalResult = undefined;
	sendQueue = Promise.resolve();
	stopRequested = false;
	captureStopped = undefined;
	bufferedBytes = 0;
	connectionReady = new Promise<void>((resolve, reject) => {
		ready = resolve;
		rejectReady = reject;
	});
	void connectionReady.catch(() => undefined);
	try {
		// No permission prompt or microphone here: overlap safe preparation with UIA.
		const audioPrepared = prepareAudio();
		void audioPrepared.catch(() => undefined);
		const tokenPrepared = auth0Service.getVoiceAccessToken().then((token) => {
			if (!token) throw new Error('Please sign in before recording. No audio was recorded.');
			startupMark('token_ready');
			return token;
		});
		void tokenPrepared.catch(() => undefined);
		const microphonePermission = navigator.permissions
			?.query({ name: 'microphone' as PermissionName })
			.then((permission) => permission.state === 'granted')
			.catch(() => false);
		// Capture remains a gate for focus-changing UI and the session context,
		// not for already-authorized microphone or backend connection preparation.
		const targetReady = invoke<Snapshot>('voice_target_capture')
			.catch((error: unknown) => {
				if (id !== sessionId || ending || isIdle()) return undefined;
				targetError = error instanceof Error ? error.message : String(error);
				recordVoiceHistory(sessionId, 'target.capture_failed', targetError);
				return undefined;
			})
			.then((capturedTarget) => {
				if (id !== sessionId || ending || isIdle()) return;
				target = capturedTarget;
				startupMark('target_ready');
				if (target) {
					recordVoiceHistory(sessionId, 'target.captured', target.packageName);
					recordVoiceHistory(
						sessionId,
						'startup.target_breakdown',
						JSON.stringify({
							uia: target.captureTimings,
							helper: target.helperTiming,
						}),
					);
					target.captureTimings = undefined;
					target.helperTiming = undefined;
				}
				return target;
			});
		const microphoneReady = (async () => {
			if (!(await tokenPrepared)) throw new Error('Please sign in before recording. No audio was recorded.');
			if (!(await microphonePermission)) await targetReady;
			if (id !== sessionId || ending || isIdle()) return;
			const deviceId = settings.value['recording.navigator.selectedDeviceId'];
			const capturedStream = await navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
				},
			});
			if (id !== sessionId || ending || isIdle()) {
				for (const track of capturedStream.getTracks()) track.stop();
				return;
			}
			stream = capturedStream;
			startupMark('microphone_open');
			const context = await audioPrepared;
			if (id !== sessionId || ending || isIdle()) return;
			audio = context;
			worklet = new AudioWorkletNode(audio, 'voice-pcm');
			let firstAudio = true;
			worklet.port.onmessage = ({ data }) => {
				if (id !== sessionId || ending || isIdle()) return;
				if (data.bufferFull) {
					assistant =
						'Audio buffer full. Recording stopped and retained; waiting to connect.';
					void render();
					if (phase === 'recording') void toggleRealtimeVoice();
					else if (phase === 'connecting') stopRequested = true;
					return;
				}
				if (data.flushed) {
					flushed?.();
					return;
				}
				if (!data.audio || id !== sessionId || ending || isIdle()) return;
				if (firstAudio) {
					firstAudio = false;
					startupMark('first_audio');
				}
				const byteLength = (data.audio as Uint8Array).byteLength;
				bufferedBytes += byteLength;
				const encoded = btoa(
					String.fromCharCode(...(data.audio as Uint8Array)),
				);
				sendQueue = sendQueue
					.then(async () => {
						await connectionReady;
						if (id !== sessionId || ending || isIdle()) return;
						// Native relay paces PCM and applies backpressure even in the background.
						bufferedBytes -= byteLength;
						if (id === sessionId && !ending && !isIdle())
							await send(
								{ type: 'audio.chunk', payload: { audio: encoded } },
								sessionId,
							);
						if (id === sessionId && !ending && !isIdle())
							worklet?.port.postMessage({ ackBytes: byteLength });
					})
					.catch((error) => fail(error, sessionId));
			};
			const mute = audio.createGain();
			muteNode = mute;
			mute.gain.value = 0;
			sourceNode = audio.createMediaStreamSource(stream);
			sourceNode.connect(worklet).connect(mute).connect(audio.destination);
			await audio.resume();
			if (id !== sessionId || ending || isIdle()) return;
			recordVoiceHistory(sessionId, 'microphone.started', undefined, {
				status: 'recording',
			});
			if (stopRequested) await stopCapture();
			await targetReady;
			if (id !== sessionId || ending || isIdle()) return;
			phase = 'recording';
			await invoke('show_recording_overlay');
			if (id !== sessionId || ending || isIdle()) return;
			startupMark('overlay_shown');
			overlayTimer = setInterval(() => void render(), 250);
			await render();
			if (stopRequested) void toggleRealtimeVoice();
		})();
		void microphoneReady.catch((error) => fail(error, sessionId));
		let token: string | null = await tokenPrepared;
		if (id !== sessionId || ending || isIdle()) return;
		if (!token) {
			await microphoneReady;
			token = await signInForRecording(sessionId);
		}
		if (id !== sessionId || ending || isIdle()) return;
		const started = connectionReady;
		let firstTranscript = true;
		const removeListener = await listen<{
			id: string;
			event: {
				diagnostics?: unknown;
				notice?: string;
				usage?: { summary: string; calls: unknown[] };
				type: string;
				text?: string;
				error?: string;
				finalText?: string;
				preferenceSuggestion?: unknown; preferenceSuggestions?: unknown;
				cursorPosition?: number;
				contextWindow?: ContextWindow;
				requestId?: string;
				beforeChars?: number;
				afterChars?: number;
				stage?: string;
				revision?: number;
				kind?: string;
                llmProvider?: string; llmModel?: string;
                attempt?: number; maxAttempts?: number; delayMs?: number;
                rttMs?: number; missed?: number; failure?: VoiceFailure; budget?: BudgetStatus;
			};
		}>('voice-stream-event', ({ payload }) => {
			if (payload.id !== sessionId || id !== sessionId || ending || isIdle())
				return;
            const event = payload.event;
			if (receivePreferenceSuggestions(event, target?.packageName || 'unknown', personalizationSettings['voiceInput.suggestPreferences'] === true))
				recordVoiceHistory(sessionId, 'preference.draft', 'Writing rule draft ready for review in Voice settings. Save it to apply it.');
            if (event.type === 'budget.warning') {
                reportBudgetStatus(event.budget);
                budgetWarning = event.text || 'WhisperMe has reached 80% of its monthly server budget.';
                recordVoiceHistory(sessionId, 'budget.warning', budgetWarning, {budgetWarning});
                void render();
            }
            if (event.type === 'connection.quality') {
                connectionStatus = connectionText(event.rttMs, event.missed, navigator.onLine === false);
                void render();
            }
            if (event.type === 'processing.retry') {
                retryText = providerRetryText(event);
                recordVoiceHistory(sessionId, 'processing.retry', retryText);
                void render();
            }
            if (event.failure) recordVoiceHistory(sessionId, 'provider.failure', event.error, {failure: event.failure});

			if (diagnosticContext && event.diagnostics)
				recordVoiceHistory(sessionId, 'diagnostics.received', undefined, {diagnostics: event.diagnostics});
			if (event.notice) {
				recordVoiceHistory(sessionId, 'preference.notice', event.notice);
				toast.success({title: 'WhisperMe', description: event.notice});
			}
			if (event.type === 'session.stopping') {
				assistant =
					event.text || 'Recording limit reached. Finishing your text…';
				recordVoiceHistory(sessionId, 'recording.limit', assistant);
				void render();
				// Release the mic and drain PCM through the ordinary stop path.
				if (phase === 'recording') void toggleRealtimeVoice();
				else if (phase === 'connecting') stopRequested = true;
			}
			if (event.type === 'usage.updated' && event.usage) {
				recordVoiceHistory(sessionId, 'usage.updated', event.usage.summary, {
					usage: event.usage,
				});
			}
			if (event.type === 'session.started') {
				startupMark('provider_ready');
				recordVoiceHistory(sessionId, 'session.started', undefined, {
					status: 'recording',
                    metadata: {...historySession(sessionId)?.metadata, llmProvider: event.llmProvider || 'Server default', llmModel: event.llmModel || 'Server default'},
				});
				ready?.();
			}
			if (
				event.type === 'transcript.partial' ||
				event.type === 'transcript.final'
			) {
				revision = event.revision ?? revision + 1;
				transcript = event.text ?? '';
				if (event.type === 'transcript.final') {
                    finalTranscriptReceived = true;
                    recordVoiceHistory(sessionId, 'recovery.saved', undefined, {finalTranscript: transcript, recovery: safeVoiceRecovery(retryPayload || {})});
                }
				if (firstTranscript && transcript) {
					firstTranscript = false;
					startupMark('first_transcript');
				}
				recordVoiceHistory(sessionId, event.type, transcript, {
					transcript,
					status: phase,
				});
				void render();
			}
			if (event.type === 'assistant.message' && event.revision === revision) {
				assistant = event.text ?? '';
				if (assistant.trim())
					recordVoiceHistory(
						sessionId,
						event.kind === 'recording_limit'
							? 'recording.limit_warning'
							: 'assistant.message',
						assistant,
					);
				void render();
			}
			if (event.type === 'assistant.review')
				recordVoiceHistory(sessionId, 'clarification.review', event.text);
			if (event.type === 'context.request')
				void provideContext(event, sessionId).catch((error) =>
					fail(error, sessionId),
				);
			if (event.type === 'processing.status') {
				retryText = '';
				statusText =
					event.stage === 'gathering_context'
						? 'Gathering more context…'
						: 'Formatting…';
				recordVoiceHistory(sessionId, 'processing.status', statusText);
				void render();
			}
			if (event.type === 'error')
				void fail(new Error(event.error || 'Voice service failed'), sessionId);
			if (event.type === 'transport.closed')
				void fail(
					new Error(navigator.onLine === false ? 'Internet unavailable (device reports offline).' : 'Connection to WhisperMe interrupted before the final result; cause unknown.'),
					sessionId,
				);
			if (
				event.type === 'processing.final_text' &&
				typeof event.finalText === 'string'
			) {
				if (isNoticeOnlyResponse(event)) {
					ending = true;
					recordVoiceHistory(sessionId, 'preference.review', event.notice, {status: 'processed', result: ''});
					void cleanup().then(async () => {
						await invoke('hide_recording_overlay').catch(() => undefined);
						toast.success({title: 'Review your draft', description: event.notice || 'Review and Save in Voice settings.', action: {type: 'link', label: 'Review draft', goto: '/settings/transcription'}});
						phase = 'idle'; ending = false;
					});
					return;
				}
				// Preserve the received result even if its edit window fails validation.
				recordVoiceHistory(sessionId, 'llm.result', event.finalText, {result: event.finalText, transcript, status: 'processing'});
				let application: { text: string; cursorPosition: number };
				try {
					if (event.contextWindow && targetWindow) {
						const expected = targetWindow.context.contextWindow;
						if (
							event.contextWindow.start !== expected.start ||
							event.contextWindow.totalLength !== expected.totalLength ||
							event.contextWindow.hasBefore !== expected.hasBefore ||
							event.contextWindow.hasAfter !== expected.hasAfter
						)
							throw new Error(
								'The editing result belongs to a different context window.',
							);
					}
					application =
						target && targetWindow
							? applyEditorWindow(
									target,
									targetWindow,
									event.finalText,
									event.cursorPosition,
								)
							: {
									text: event.finalText,
									cursorPosition: event.finalText.length,
								};
				} catch (error) {
					void fail(error, sessionId);
					return;
				}
				ending = true;
				finalTranscriptReceived = false;
				const result = application.text;
				const snapshot = target;
				// Remove listeners before applying; a normal socket close must not erase success.
				void cleanup().then(async () => {
					let applied = false;
					let applyError =
						targetError ||
						'No editable field was captured. Focus the text field before starting.';
					if (snapshot)
						applied = await invoke('voice_target_apply', {
							snapshot,
							text: result,
							cursorPosition: application.cursorPosition,
						})
							.then(() => true)
							.catch((error: unknown) => {
								applyError =
									error instanceof Error ? error.message : String(error);
								return false;
							});
					recordVoiceHistory(
						sessionId,
						applied ? 'insertion.applied' : 'insertion.failed',
						applied ? undefined : applyError,
						{ status: applied ? 'applied' : 'insertion_failed' },
					);
					if (applied)
						await invoke('hide_recording_overlay').catch(() => undefined);
					else {
						finalResult = result;
						assistant = applyError;
						phase = 'idle';
						await render();
					}
					toast.success({
						title: applied
							? 'Voice text applied'
							: 'Voice text ready — copy to your field',
						description:
							result.length <= 600 ? result : 'Your edited text is ready.',
						action: {
							type: 'button',
							label: 'Copy result',
							onClick: () => writeText(result),
						},
					});
					phase = 'idle';
					ending = false;
				});
			}
		});
		if (id !== sessionId || ending || isIdle()) {
			removeListener();
			return;
		}
		unlisten = removeListener;
		try {
			await invoke('voice_stream_open', {
				id: sessionId,
				endpoint: settings.value['voiceInput.endpoint'],
				token,
			});
		} catch (error) {
			if (!/401|unauthorized/i.test(String(error))) throw error;
			token = await auth0Service.getVoiceAccessToken(true);
			if (id !== sessionId || ending || isIdle()) return;
			if (!token) {
				await microphoneReady;
				token = await signInForRecording(sessionId);
			}
			if (id !== sessionId || ending || isIdle()) return;
			try {
				await invoke('voice_stream_open', {
					id: sessionId,
					endpoint: settings.value['voiceInput.endpoint'],
					token,
				});
			} catch (retryError) {
				if (!/401|unauthorized/i.test(String(retryError))) throw retryError;
				await microphoneReady;
				token = await signInForRecording(sessionId);
				if (id !== sessionId || ending || isIdle()) return;
				await invoke('voice_stream_open', {
					id: sessionId,
					endpoint: settings.value['voiceInput.endpoint'],
					token,
				});
			}
		}
		if (id !== sessionId || ending || isIdle()) {
			await invoke('voice_stream_close', { id: sessionId });
			return;
		}
        startupMark('backend_connected');
        // Optional feature: older servers receive no new heartbeat messages.
        void invoke<{features?: {connectionHeartbeat?: boolean}; connectionHeartbeat?: boolean}>('voice_backend_status', {endpoint: settings.value['voiceInput.endpoint'], token})
            .then(async (capabilities) => {
                await connectionReady;
                if (id !== sessionId || ending || isIdle()) return;
                if (capabilities?.features?.connectionHeartbeat === true || capabilities?.connectionHeartbeat === true)
                    await send({type: 'connection.configure', enabled: true}, sessionId);
                else { connectionStatus = 'Connection measurement unavailable on this server'; void render(); }
            }).catch(() => { if (id === sessionId && !isIdle()) { connectionStatus = 'Connection measurement unavailable'; void render(); } });

		const capturedTarget = await targetReady;
		if (capturedTarget) rememberVoiceApp(capturedTarget.packageName);
		// A permission dialog may stay open indefinitely. Don't start a provider
		// stream with an audio-ingress deadline until permission is settled.
		if (!(await microphonePermission)) await microphoneReady;
		if (id !== sessionId || ending || isIdle()) return;
		targetWindow = capturedTarget
			? createEditorWindow(capturedTarget)
			: undefined;
		const context = targetWindow
			? targetWindow.context
			: {
					fullText: '',
					textBeforeCursor: '',
					textAfterCursor: '',
					selectedText: '',
					cursorPosition: 0,
					packageName: 'unknown',
				};
		retryPayload = {
			platform: platform(), context: {...context, isPasswordField: false, isRichEditor: capturedTarget?.isRichEditor ?? false, locale: navigator.language, supportsDictionaryConfirmation: true, supportsPreferenceConfirmation: true, supportsScopedPreferenceConfirmation: true},
			...llmRoutingOptions(settings.value['voiceInput.llmRouting'], settings.value['voiceInput.llmProvider'], settings.value['voiceInput.llmModel'], settings.value['voiceInput.reasoningEffort']),
			mode: settings.value['voiceInput.mode'], usePreferences, diagnosticContext,
			...personalizationOptions(personalizationSettings, context.packageName),
			preferenceProfile: usePreferences ? selectStyleProfile(profiles, categories, context.packageName) : undefined,
		};
		await send({
			type: 'session.start',
			payload: {
				platform: platform(),
				context: {
					...context,
					supportsDictionaryConfirmation: true,
					supportsPreferenceConfirmation: true,
					supportsScopedPreferenceConfirmation: true,
					isPasswordField: false,
					isRichEditor: capturedTarget?.isRichEditor ?? false,
					locale: navigator.language,
				},
				transcriptionProvider:
					settings.value['voiceInput.transcriptionProvider'],
				transcriptionModel: settings.value['voiceInput.transcriptionModel'],
				...llmRoutingOptions(settings.value['voiceInput.llmRouting'], settings.value['voiceInput.llmProvider'], settings.value['voiceInput.llmModel'], settings.value['voiceInput.reasoningEffort']),
				mode: settings.value['voiceInput.mode'],
				liveHints: settings.value['voiceInput.liveHints'],
				usePreferences,
				...personalizationOptions(personalizationSettings, context.packageName),
				diagnosticContext,
				preferenceProfile: usePreferences ? selectStyleProfile(profiles, categories, context.packageName) : undefined,
			},
		});
		await Promise.race([
			started,
			new Promise<never>((_, reject) =>
				startupTimeout = setTimeout(
					() => reject(new Error('Voice provider did not become ready')),
					90000,
				),
			),
		]);
		clearTimeout(startupTimeout);
		await microphoneReady;
		if (id !== sessionId || ending || isIdle()) return;
	} catch (error) {
		await fail(error, sessionId);
	}
}
