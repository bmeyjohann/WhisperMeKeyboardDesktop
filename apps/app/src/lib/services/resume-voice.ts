import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { voiceFeedback, connectionText, providerRetryText, reportBudgetStatus, type BudgetStatus, type VoiceFailure } from './voice-feedback';
import { historySession, recordVoiceHistory } from './voice-history';

type Result = { success: boolean; finalText?: string; error?: string; failure?: VoiceFailure; budget?: BudgetStatus; usage?: {summary: string; calls: unknown[]} };
type Event = Result & { type: string; text?: string; stage?: string; attempt?: number; maxAttempts?: number; rttMs?: number; missed?: number; llmProvider?: string; llmModel?: string };

/** Only complete, saved ASR text is supplied by the caller. This path never opens a microphone or editor. */
export async function resumeVoiceTranscript(sessionId: string, endpoint: string, token: string, payload: Record<string, unknown>): Promise<Result> {
	const capabilities = await invoke<{features?: {resumeTranscript?: boolean; connectionHeartbeat?: boolean}}>('voice_backend_status', {endpoint, token}).catch(() => undefined);
	if (!capabilities?.features?.resumeTranscript) {
		voiceFeedback.set({connection: '', retry: 'Processing the saved transcript. Up to two provider retries may occur; this server does not stream retry progress.'});
		const result = await invoke<Result>('voice_preferences_request', {endpoint, token, path: '/process-transcript', method: 'POST', body: payload});
		const warning = reportBudgetStatus(result.budget || result.failure?.budget);
		if (warning) recordVoiceHistory(sessionId, 'budget.warning', warning, {budgetWarning: warning});
		return result;
	}
	const streamId = `resume-${crypto.randomUUID()}`;
	let resolve!: (result: Result) => void;
	let reject!: (error: Error) => void;
	let usage: Result['usage'];
	const completed = new Promise<Result>((yes, no) => {resolve = yes; reject = no;});
	void completed.catch(() => undefined);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const unlisten = await listen<{id: string; event: Event}>('voice-stream-event', ({payload: message}) => {
		if (message.id !== streamId) return;
		const event = message.event;
		if (event.type === 'budget.warning') {
			reportBudgetStatus(event.budget);
			const text = event.text || 'WhisperMe has reached 80% of its monthly server budget.';
			voiceFeedback.update(value => ({...value, budget: text}));
			recordVoiceHistory(sessionId, 'budget.warning', text, {budgetWarning: text});
		}
		if (event.type === 'connection.quality') voiceFeedback.update(value => ({...value, connection: connectionText(event.rttMs, event.missed, navigator.onLine === false)}));
		if (event.type === 'session.started') recordVoiceHistory(sessionId, 'retry.connected', undefined, {metadata: {...historySession(sessionId)?.metadata, llmProvider: event.llmProvider || 'Server default', llmModel: event.llmModel || 'Server default'}});
		if (event.type === 'processing.retry' || event.type === 'processing.status') {
			const text = event.type === 'processing.retry' ? providerRetryText(event) : event.text || 'Formatting the saved transcript…';
			voiceFeedback.update(value => ({...value, retry: text}));
			recordVoiceHistory(sessionId, event.type, text);
		}
		if (event.type === 'usage.updated') usage = event.usage;
		if (event.type === 'processing.final_text' && typeof event.finalText === 'string') resolve({success: true, finalText: event.finalText, usage: event.usage || usage});
		if (event.type === 'error') resolve({success: false, error: event.error || 'Text processing failed', failure: event.failure, usage: event.usage || usage});
		if (event.type === 'transport.closed' || event.type === 'session.closed') reject(new Error('Connection to WhisperMe ended before the recovered result; cause unknown.'));
	});
	try {
		timer = setTimeout(() => reject(new Error('Saved transcript processing timed out; cause unknown.')), 160000);
		await invoke('voice_stream_open', {id: streamId, endpoint, token});
		await invoke('voice_stream_send', {id: streamId, message: JSON.stringify({type: 'session.start', payload})});
		if (capabilities.features.connectionHeartbeat) await invoke('voice_stream_send', {id: streamId, message: JSON.stringify({type: 'connection.configure', enabled: true})});
		return await completed;
	} finally {
		clearTimeout(timer);
		unlisten();
		await invoke('voice_stream_close', {id: streamId}).catch(() => undefined);
	}
}
