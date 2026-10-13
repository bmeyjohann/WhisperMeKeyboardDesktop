import { writable, get } from 'svelte/store';
import type { VoiceFailure } from './voice-feedback';

export type VoiceRecovery = {
	version: 1;
	llmRouting: 'server' | 'explicit';
	llmProvider: string;
	llmModel?: string;
	reasoningEffort: 'default' | 'none' | 'low' | 'medium' | 'high';
	mode: 'verbatim' | 'clean';
};

/** Allowlist only. No credentials, audio, editor contents, prompts or target identity. */
export function safeVoiceRecovery(payload: Record<string, unknown>): VoiceRecovery {
	const explicit = payload.llmRouting === 'explicit';
	return {
		version: 1,
		llmRouting: explicit ? 'explicit' : 'server',
		llmProvider: explicit && typeof payload.llmProvider === 'string' ? payload.llmProvider : 'default',
		...(explicit && typeof payload.llmModel === 'string' ? {llmModel: payload.llmModel} : {}),
		reasoningEffort: ['none', 'low', 'medium', 'high'].includes(String(payload.reasoningEffort)) && !(explicit && /gpt-oss/i.test(String(payload.llmModel)) && payload.reasoningEffort === 'none')
			? payload.reasoningEffort as VoiceRecovery['reasoningEffort'] : 'default',
		mode: payload.mode === 'verbatim' ? 'verbatim' : 'clean',
	};
}

export type VoiceHistoryEvent = {
	at: number;
	stage: string;
	text?: string;
	truncated?: boolean;
};
export type VoiceHistorySession = {
	budgetWarning?: string;
	finalTranscript?: string;
	recovery?: VoiceRecovery;
	failure?: VoiceFailure;
	diagnostics?: unknown;
	usage?: { summary: string; calls: unknown[] };
	id: string;
	startedAt: number;
	updatedAt: number;
	status: string;
	metadata: Record<string, string>;
	transcript: string;
	result: string;
	events: VoiceHistoryEvent[];
	omittedEvents: number;
};
export const voiceHistory = writable<VoiceHistorySession[]>([]);
export const voiceHistoryStorageError = writable('');
let database: Promise<IDBDatabase> | undefined;
let initialized: Promise<void> | undefined;
let writes = Promise.resolve();
function db() {
	database ??= new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open('whisperme-voice-history', 1);
		request.onupgradeneeded = () =>
			request.result.createObjectStore('sessions', { keyPath: 'id' });
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
		request.onblocked = () =>
			reject(new Error('History database is blocked by another window'));
	});
	return database;
}
function storageFailure() {
	voiceHistoryStorageError.set(
		'History could not be saved on this device. Keep the app open and copy any important results.',
	);
}
export function initVoiceHistory() {
	initialized ??= (async () => {
		try {
			const database = await db();
			const saved = await new Promise<VoiceHistorySession[]>(
				(resolve, reject) => {
					const request = database
						.transaction('sessions')
						.objectStore('sessions')
						.getAll();
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				},
			);
			voiceHistory.update((current) => {
				const ids = new Set(current.map((s) => s.id));
				return [
					...current,
					...saved
						.filter((s) => !ids.has(s.id))
						.map((s) => ({
							...s,
							status: ['connecting', 'recording', 'processing'].includes(
								s.status,
							)
								? 'interrupted'
								: s.status,
						})),
				].sort((a, b) => b.startedAt - a.startedAt);
			});
		} catch {
			storageFailure();
		}
	})();
	return initialized;
}
function persist(session: VoiceHistorySession | string) {
	writes = writes
		.then(async () => {
			await initVoiceHistory();
			const database = await db();
			await new Promise<void>((resolve, reject) => {
				const tx = database.transaction('sessions', 'readwrite');
				const table = tx.objectStore('sessions');
				if (typeof session === 'string') table.delete(session);
				else table.put(session);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error);
			});
		})
		.catch(storageFailure);
}
export function beginVoiceHistory(
	id: string,
	metadata: Record<string, string>,
) {
	void initVoiceHistory();
	const now = Date.now();
	const session: VoiceHistorySession = {
		id,
		startedAt: now,
		updatedAt: now,
		status: 'connecting',
		metadata,
		transcript: '',
		result: '',
		events: [],
		omittedEvents: 0,
	};
	voiceHistory.update((rows) => [
		session,
		...rows.filter((row) => row.id !== id),
	]);
	persist(session);
}
export function appendHistoryEvent(
	session: VoiceHistorySession,
	stage: string,
	text?: string,
): VoiceHistorySession {
	const now = Date.now();
	const event: VoiceHistoryEvent = {
		at: now,
		stage,
		...(text === undefined
			? {}
			: { text: text.slice(0, 4000), truncated: text.length > 4000 }),
	};
	const events = [...session.events, event];
	const omitted = events.length > 200 ? events.length - 200 : 0;
	return {
		...session,
		updatedAt: now,
		events: events.slice(-200),
		omittedEvents: session.omittedEvents + omitted,
	};
}
export function recordVoiceHistory(
	id: string,
	stage: string,
	text?: string,
	patch: Partial<
		Pick<VoiceHistorySession, 'status' | 'transcript' | 'result' | 'usage' | 'diagnostics' | 'finalTranscript' | 'recovery' | 'failure' | 'metadata' | 'budgetWarning'>
	> = {},
) {
	let updated: VoiceHistorySession | undefined;
	voiceHistory.update((rows) =>
		rows.map((session) => {
			if (session.id !== id) return session;
			updated = { ...appendHistoryEvent(session, stage, text), ...patch };
			return updated;
		}),
	);
	if (updated) persist(updated);
}
export async function deleteVoiceHistory(id: string) {
	await initVoiceHistory();
	voiceHistory.update((rows) => rows.filter((row) => row.id !== id));
	persist(id);
}
export function historySession(id: string) {
	return get(voiceHistory).find((session) => session.id === id);
}
