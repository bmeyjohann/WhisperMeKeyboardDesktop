import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const source = await readFile(
	new URL('../src/lib/services/voice-history.ts', import.meta.url),
	'utf8',
);
const compiled = ts.transpileModule(source, {
	compilerOptions: {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES2022,
	},
}).outputText;
function load(indexedDB) {
	const exports = {};
	runInNewContext(compiled, {
		exports,
		Date,
		Set,
		Promise,
		indexedDB,
		require: () => ({
			get: store => {let value; store.subscribe(v => {value = v;})(); return value;},
			writable: (initial) => {
				let value = initial;
				return {
					set(next) {
						value = next;
					},
					update(fn) {
						value = fn(value);
					},
					subscribe(fn) {
						fn(value);
						return () => {};
					},
				};
			},
		}),
	});
	return exports;
}
test('recovery allowlist removes credentials, audio, editor contents and saved prompts', () => {
	const api = load();
	const recovery = api.safeVoiceRecovery({llmRouting: 'server', llmProvider: 'cerebras_glm_4_7', llmModel: 'private-model', reasoningEffort: 'high', mode: 'command', token: 'secret', audio: 'bytes', context: {fullText: 'private'}, preferenceProfile: {instructions: 'private'}});
	assert.deepEqual(JSON.parse(JSON.stringify(recovery)), {version: 1, llmRouting: 'server', llmProvider: 'default', reasoningEffort: 'high', mode: 'clean'});
	assert.equal(api.safeVoiceRecovery({llmRouting: 'explicit', llmModel: 'gpt-oss-120b', reasoningEffort: 'none'}).reasoningEffort, 'default');
});
test('IndexedDB restart preserves the full confirmed transcript and safe retry payload', async () => {
	const rows = new Map();
	const indexedDB = {open() {
		const request = {};
		setImmediate(() => {
			request.result = {transaction() {
				const tx = {objectStore: () => ({
					getAll() {const req = {}; setImmediate(() => {req.result = [...rows.values()].map(row => structuredClone(row)); req.onsuccess();}); return req;},
					put(row) {rows.set(row.id, structuredClone(row)); setImmediate(() => tx.oncomplete());},
					delete(id) {rows.delete(id); setImmediate(() => tx.oncomplete());},
				})}; return tx;
			}};
			request.onsuccess();
		}); return request;
	}};
	const original = load(indexedDB);
	await original.initVoiceHistory();
	const full = 'Complete provider-confirmed speech. '.repeat(1000);
	original.beginVoiceHistory('saved', {reasoningEffort: 'high'});
	original.recordVoiceHistory('saved', 'transcript.final', full, {status: 'processing', transcript: full, finalTranscript: full, budgetWarning: 'Monthly budget at 80%', recovery: original.safeVoiceRecovery({mode: 'clean', reasoningEffort: 'high'})});
	for (let i = 0; i < 8; i++) await new Promise(setImmediate);
	const restarted = load(indexedDB);
	await restarted.initVoiceHistory();
	const saved = restarted.historySession('saved');
	assert.equal(saved.status, 'interrupted');
	assert.equal(saved.finalTranscript, full);
	assert.equal(saved.recovery.reasoningEffort, 'high');
	assert.equal(saved.budgetWarning, 'Monthly budget at 80%');
	assert.equal(saved.events[0].truncated, true);
	await restarted.deleteVoiceHistory('saved');
	for (let i = 0; i < 4; i++) await new Promise(setImmediate);
	assert.equal(rows.size, 0);
});
test('history bounds intermediate revisions without discarding full final fields', () => {
	const api = load();
	const full = 'full transcript '.repeat(1000);
	let session = {
		id: 'a',
		startedAt: 0,
		updatedAt: 0,
		status: 'recording',
		metadata: {},
		transcript: full,
		result: 'Final result',
		budgetWarning: 'Monthly budget at 80%',
		events: [],
		omittedEvents: 0,
	};
	for (let i = 0; i < 205; i++)
		session = api.appendHistoryEvent(session, 'transcript.partial', String(i));
	assert.equal(session.events.length, 200);
	assert.equal(session.omittedEvents, 5);
	assert.equal(session.events[0].text, '5');
	assert.equal(session.transcript, full);
	assert.equal(session.result, 'Final result');
	assert.equal(session.budgetWarning, 'Monthly budget at 80%');
});
test('long event previews are explicitly marked and errors remain distinct', () => {
	const api = load();
	const session = {
		id: 'a',
		startedAt: 0,
		updatedAt: 0,
		status: 'processing',
		metadata: {},
		transcript: 'Speech',
		result: 'Edited result',
		events: [],
		omittedEvents: 0,
	};
	const updated = api.appendHistoryEvent(
		session,
		'llm.result',
		'x'.repeat(5000),
	);
	assert.equal(updated.events[0].text.length, 4000);
	assert.equal(updated.events[0].truncated, true);
	const failed = api.appendHistoryEvent(
		updated,
		'insertion.failed',
		'Field changed',
	);
	assert.equal(failed.events[1].text, 'Field changed');
	assert.equal(failed.result, 'Edited result');
	assert.equal(failed.transcript, 'Speech');
});
