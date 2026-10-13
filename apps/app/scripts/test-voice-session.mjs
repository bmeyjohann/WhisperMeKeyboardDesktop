import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source = await readFile(
	new URL('../src/lib/services/realtime-voice.ts', import.meta.url),
	'utf8',
);
const compiled = ts.transpileModule(source, {
	compilerOptions: {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES2022,
	},
}).outputText;
const sources = {};
for (const name of ['preference-contract', 'style-profile', 'preference-drafts', 'voice-feedback', 'resume-voice']) sources[name] = ts.transpileModule(await readFile(new URL(`../src/lib/services/${name}.ts`, import.meta.url), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const editorWindow = {};
runInNewContext(
	ts.transpileModule(
		await readFile(
			new URL('../src/lib/services/editor-window.ts', import.meta.url),
			'utf8',
		),
		{
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
			},
		},
	).outputText,
	{ exports: editorWindow, Error },
);
function harness(capture, options = {}) {
	const calls = [];
	const messages = [];
	const timers = new Set();
	let listener;
	const history = new Map(options.savedHistory?.map(s => [s.id, structuredClone(s)]) || []);
	let sessionId;
	let sequence = 0;
	let microphone;
	let tokenListener;
	const snapshot = {
		fullText: '',
		textBeforeCursor: '',
		selectedText: '',
		textAfterCursor: '',
		packageName: 'test',
		identity: '1',
	};
	const emit = (event) => listener?.({ payload: { id: sessionId, event } });
	const invoke = async (command, args) => {
		calls.push({ command, args, time: Date.now() });
		if (command === 'voice_backend_status') return options.capabilities;
		if (command === 'voice_stream_open' && options.open)
			await options.open(args);
		if (command === 'voice_preferences_request') return options.retry ? options.retry(args) : {success: true, finalText: 'Recovered.'};
		if (command === 'voice_target_capture')
			return capture ? capture() : snapshot;
		if (command === 'voice_target_apply' && options.apply)
			return options.apply(args);
		if (command === 'voice_stream_open') sessionId = args.id;
		if (
			command === 'voice_stream_send' &&
			JSON.parse(args.message).type === 'session.start'
		)
			if (!options.delayReady) emit({ type: 'session.started' });
	};
	class AudioContext {
		constructor() {
			calls.push({ command: 'audio.create' });
		}
		sampleRate = 16000;
		audioWorklet = {
			addModule: async () => {
				calls.push({ command: 'audio.module' });
			},
		};
		createGain() {
			return { gain: { value: 0 }, disconnect() {} };
		}
		createMediaStreamSource() {
			return { connect: (node) => node, disconnect() {} };
		}
		async resume() {}
		async suspend() {
			calls.push({ command: 'audio.suspend' });
		}
		async close() {}
	}
	class AudioWorkletNode {
		constructor() {
			microphone = this;
		}
		port = {
			postMessage: (message) => {
				if (message === 'flush')
					this.port.onmessage({ data: { flushed: true } });
			},
		};
		connect() {
			return this;
		}
		disconnect() {}
	}
	const modules = {
		'svelte/store': {writable: initial => {let value = initial; return {set: v => {value = v;}, update: fn => {value = fn(value);}, subscribe: fn => {fn(value); return () => {};}};}},
		'./editor-window': editorWindow,
        './style-profile': { selectStyleProfile: () => undefined },
		'./voice-history': {
			historySession: id => history.get(id),
			initVoiceHistory: async () => {},
			safeVoiceRecovery: payload => ({version: 1, llmRouting: payload.llmRouting || 'server', llmProvider: payload.llmProvider || 'default', mode: payload.mode === 'verbatim' ? 'verbatim' : 'clean'}),
			beginVoiceHistory: (...args) => {history.set(args[0], {id: args[0], metadata: args[1]}); calls.push({command: 'history.begin', args});},
			recordVoiceHistory: (...args) => {history.set(args[0], {...history.get(args[0]), ...args[3]}); calls.push({command: 'history.event', args});},
		},
		'$lib/constants/transcription/backend-provider-config': {
			compatibleLlmModel: () => 'qwen/qwen3.8-27b',
			llmRoutingOptions: (routing, provider, model) => routing === 'explicit' ? {llmRouting: routing, llmProvider: provider, llmModel: model} : {llmRouting: 'server', llmProvider: 'default'},
		},
		'@tauri-apps/api/core': { invoke },
		'@tauri-apps/api/event': {
			listen: async (_, callback) => {
				listener = callback;
				return () => {
					listener = undefined;
				};
			},
		},
		'@tauri-apps/plugin-clipboard-manager': { writeText: async () => {} },
		'@tauri-apps/plugin-os': { platform: () => 'windows' },
		'$lib/stores/settings.svelte': {
			settings: {
				value: {
					'transcription.selectedTranscriptionService': 'WhisperMe',
					'voiceInput.transcriptionProvider': 'voxtral_realtime',
					...(options.settings || {}),
				},
			},
		},
		'./auth0': {
			auth0Service: {
				getVoiceAccessToken: async (force) => {
					calls.push({ command: 'token', force });
					return options.token ? options.token(force) : 'synthetic-token';
				},
				accessToken: {
					subscribe(callback) {
						tokenListener = callback;
						callback(null);
						return () => {
							tokenListener = undefined;
						};
					},
				},
				login: async () => {
					calls.push({ command: 'login' });
				},
			},
		},
		'$lib/toast': {
			toast: {
				success: (value) => messages.push(value),
				error: (value) => messages.push(value),
			},
		},
	};
	for (const name of ['preference-contract', 'style-profile', 'preference-drafts', 'voice-feedback', 'resume-voice']) {
		const exports = {};
		runInNewContext(sources[name], {exports, require: name => modules[name], TextEncoder, navigator: {onLine: true}, crypto: {randomUUID: () => String(++sequence)}, setTimeout, clearTimeout});
		modules[`./${name}`] = exports;
	}
	const exports = {};
	runInNewContext(compiled, {
		exports,
		Error,
		require: (name) => modules[name],
		AudioContext,
		AudioWorkletNode,
		performance,
		crypto: { randomUUID: () => String(++sequence) },
		navigator: {
			language: 'en',
			permissions: {
				query: async () => ({ state: options.permission ?? 'granted' }),
			},
			mediaDevices: {
				getUserMedia: async () => {
					calls.push({ command: 'microphone' });
					if (options.microphone) await options.microphone();
					return {
						getTracks: () => [
							{
								stop() {
									calls.push({ command: 'microphone.stop' });
								},
							},
						],
					};
				},
			},
		},
		setTimeout: (fn, delay) => {
			const timer = setTimeout(fn, delay);
			timers.add(timer);
			return timer;
		},
		clearTimeout,
		setInterval: () => 0,
		clearInterval: () => {},
		btoa: (value) => Buffer.from(value).toString('base64'),
	});
	return {
		api: exports,
		settings: modules['$lib/stores/settings.svelte'].settings,
		calls,
		messages,
		emit,
		frame: (bytes = 3200) =>
			microphone.port.onmessage({ data: { audio: new Uint8Array(bytes) } }),
		signedIn: () => tokenListener?.('signed-in-token'),
		dispose: () => {
			for (const timer of timers) clearTimeout(timer);
		},
	};
}

test('realtime carries dictionary, canonical category and native confirmation capabilities', async () => {
	const h = harness(undefined, {settings: {'voiceInput.useDictionary':true,'voiceInput.dictionary':['MEYJOHANN'],'voiceInput.suggestPreferences':true,'voiceInput.appCategories':[{app:'test',category:'development'}]}});
	try {
		await h.api.toggleRealtimeVoice();
		const start = h.calls.filter(call => call.command === 'voice_stream_send').map(call => JSON.parse(call.args.message)).find(message => message.type === 'session.start');
		assert.deepEqual(start.payload.dictionary, ['MEYJOHANN']); assert.equal(start.payload.appCategory, 'development'); assert.equal(start.payload.suggestPreferences, true);
		assert.equal(start.payload.context.supportsDictionaryConfirmation, true); assert.equal(start.payload.context.supportsScopedPreferenceConfirmation, true);
		await h.api.cancelRealtimeVoice();
	} finally {h.dispose();}
});
test('notice-only standalone dictionary and scoped writing controls never apply editor text', async () => {
	for (const suggestion of [{kind:'dictionary',text:'MEYJOHANN',requiresConfirmation:true}, {kind:'preference',text:'Use short sentences',scope:'category',categoryId:'education',requiresConfirmation:true,scopeLocked:false}]) {
		const h = harness(undefined, {settings:{'voiceInput.suggestPreferences':true}});
		try {
			await h.api.toggleRealtimeVoice();
			h.emit({type:'processing.final_text',finalText:'Unexpected replacement',notice:'Review this draft.',preferenceSuggestion:suggestion});
			await tick(); await tick();
			assert.equal(h.calls.some(call => call.command === 'voice_target_apply'), false);
			assert.equal(h.settings.value['voiceInput.preferenceDrafts'].length, 1);
			assert.equal(h.api.isVoiceSessionActive(), false);
		} finally {h.dispose();}
	}
});
test('ordinary correction suggestion still applies text with absent or false confirmation marker', async () => {
	for (const marker of [undefined, false]) {
		const h = harness(undefined, {settings:{'voiceInput.suggestPreferences':true}});
		try {
			await h.api.toggleRealtimeVoice();
			h.emit({type:'processing.final_text',finalText:'MEYJOHANN',preferenceSuggestion:{kind:'dictionary',text:'MEYJOHANN',requiresConfirmation:marker}});
			await tick(); await tick();
			assert.equal(h.calls.filter(call => call.command === 'voice_target_apply').length, 1);
			assert.equal(h.settings.value['voiceInput.preferenceDrafts'][0].ruleText, 'MEYJOHANN');
			assert.equal(h.settings.value['voiceInput.useDictionary'], undefined);
		} finally {h.dispose();}
	}
});
test('persisted complete transcript resumes after module restart without capturing an editor', async () => {
	const h = harness(undefined, {retry: () => ({success: true, finalText: 'Recovered', budget: {warning: true, committedUsd: 8, limitUsd: 10, resetsAt: '2099-10-01T00:00:00Z'}}), savedHistory: [{id: 'old', status: 'interrupted', finalTranscript: 'Complete saved words.', recovery: {version: 1, llmRouting: 'server', llmProvider: 'default', mode: 'clean'}}]});
	try {
		await h.api.retryVoiceProcessing('old');
		const request = h.calls.find(c => c.command === 'voice_preferences_request');
		assert.equal(request.args.body.transcript, 'Complete saved words.');
		assert.equal(h.calls.some(c => ['microphone', 'voice_target_capture', 'voice_target_apply'].includes(c.command)), false);
		assert.ok(h.calls.some(c => c.command === 'history.event' && c.args[3]?.status === 'copy_ready'));
		assert.ok(h.calls.some(c => c.command === 'history.event' && c.args[3]?.budgetWarning?.includes('$8.00 of $10.00')));
	} finally {h.dispose();}
});
test('server routing omits the client model and explicit routing preserves overrides', async () => {
	for (const routing of ['server', 'explicit']) {
		const h = harness(undefined, {settings: {'voiceInput.llmRouting': routing, 'voiceInput.llmProvider': 'cerebras_glm_4_7', 'voiceInput.llmModel': 'gemma-4-31b'}});
		try {
			await h.api.toggleRealtimeVoice();
			const start = h.calls.filter(c => c.command === 'voice_stream_send').map(c => JSON.parse(c.args.message)).find(m => m.type === 'session.start');
			assert.equal(start.payload.llmRouting, routing);
			assert.equal(start.payload.llmProvider, routing === 'server' ? 'default' : 'cerebras_glm_4_7');
			assert.equal(start.payload.llmModel, routing === 'server' ? undefined : 'gemma-4-31b');
			await h.api.cancelRealtimeVoice();
		} finally {h.dispose();}
	}
});
test('provider retries and measured connection status do not overwrite speech captions', async () => {
	const h = harness();
	try {
		await h.api.toggleRealtimeVoice();
		h.emit({type: 'transcript.partial', text: 'My spoken words'});
		h.emit({type: 'processing.retry', stage: 'llm', attempt: 2, maxAttempts: 3, text: 'Provider busy; retrying'});
		h.emit({type: 'connection.quality', missed: 2});
		h.emit({type: 'budget.warning', text: 'Monthly budget at 80%'});
		const data = h.calls.filter(c => c.command === 'voice_overlay_update').at(-1).args.data;
		assert.equal(data.transcript, 'My spoken words');
		assert.equal(data.retryText, 'Provider busy; retrying');
		assert.equal(data.budgetWarning, 'Monthly budget at 80%');
		assert.match(data.connectionStatus, /WhisperMe.*cause unknown/);
		assert.doesNotMatch(data.connectionStatus, /internet unavailable/i);
		h.emit({type: 'error', error: 'Monthly budget exhausted', failure: {code: 'budget_exhausted', stage: 'llm', retryable: false}});
		await tick(); await tick();
		assert.ok(h.calls.some(c => c.command === 'history.event' && c.args[3]?.failure?.code === 'budget_exhausted'));
		await h.api.cancelRealtimeVoice();
	} finally {h.dispose();}
});
test('WebSocket resume reports actual provider retry progress without microphone capture', async () => {
	const h = harness(undefined, {capabilities: {features: {resumeTranscript: true, connectionHeartbeat: true}}, savedHistory: [{id: 'old', status: 'interrupted', finalTranscript: 'Saved words', recovery: {version: 1, llmRouting: 'server', llmProvider: 'default', mode: 'clean'}}]});
	try {
		const retry = h.api.retryVoiceProcessing('old');
		await tick(); await tick();
		const start = h.calls.filter(c => c.command === 'voice_stream_send').map(c => JSON.parse(c.args.message)).find(m => m.type === 'session.start');
		assert.equal(start.payload.transcript, 'Saved words');
		h.emit({type: 'processing.retry', stage: 'llm', attempt: 2, maxAttempts: 3, text: 'Actual provider retry'});
		h.emit({type: 'processing.final_text', finalText: 'Saved words.'});
		h.emit({type: 'transport.closed'});
		await retry;
		assert.ok(h.calls.some(c => c.command === 'history.event' && c.args[1] === 'processing.retry'));
		assert.equal(h.calls.some(c => ['voice_preferences_request', 'voice_target_apply', 'microphone'].includes(c.command)), false);
	} finally {h.dispose();}
});

test('partial transcript failure is never replayed as complete dictation', async () => {
	const h = harness();
	try {
		await h.api.toggleRealtimeVoice();
		h.emit({type:'transcript.partial',text:'Incomplete'});
		h.emit({type:'error',error:'Lost stream'});
		await tick(); await tick();
		const sessionId = h.calls.find(c=>c.command === 'voice_stream_open').args.id;
		await h.api.retryVoiceProcessing(sessionId);
		assert.equal(h.calls.filter(c=>c.command === 'voice_preferences_request').length,0);
	} finally {h.dispose();}
});
test('final transcript retry is copy-only and duplicate clicks do not rerun processing', async () => {
	const h = harness();
	try {
		await h.api.toggleRealtimeVoice();
		h.emit({type:'transcript.final',text:'Recovered.'});
		h.emit({type:'error',error:'LLM unavailable'});
		await tick(); await tick();
		const sessionId = h.calls.find(c=>c.command === 'voice_stream_open').args.id;
		await Promise.all([h.api.retryVoiceProcessing(sessionId), h.api.retryVoiceProcessing(sessionId)]);
		await h.api.retryVoiceProcessing(sessionId);
		assert.equal(h.calls.filter(c=>c.command === 'voice_preferences_request').length,1);
		assert.equal(h.calls.filter(c=>c.command === 'voice_target_apply').length,0);
		assert.equal(h.calls.filter(c=>c.command === 'microphone').length,1);
	} finally {h.dispose();}
});
test('personalization and diagnostic context are opt-in per session', async () => {
	for (const enabled of [false,true]) {
		const h = harness(undefined,{settings:{'voiceInput.usePreferences':enabled,'voiceInput.diagnosticContext':enabled}});
		try {
			await h.api.toggleRealtimeVoice();
			const start = h.calls.filter(c=>c.command==='voice_stream_send').map(c=>JSON.parse(c.args.message)).find(m=>m.type==='session.start');
			assert.equal(start.payload.usePreferences,enabled);
			assert.equal(start.payload.diagnosticContext,enabled);
			h.emit({type:'error',error:'Fixture',diagnostics:{version:1,entries:[]}});
			await tick(); await tick();
			assert.equal(h.calls.some(c=>c.command==='history.event' && c.args[1]==='diagnostics.received'),enabled);
		} finally {h.dispose();}
	}
});
test('retry deliberately excludes expanded editor context and formats complete speech only', async () => {
	const before = 'A'.repeat(9000), after = 'Z'.repeat(9000);
	const h = harness(() => ({fullText:before+after,textBeforeCursor:before,textAfterCursor:after,selectedText:'',packageName:'fixture',identity:'1'}), {
		retry: args => {
			assert.equal(args.body.context.contextWindow, undefined);
			assert.equal(args.body.context.fullText, '');
			assert.equal(args.body.mode, 'clean');
			assert.equal(args.body.diagnosticContext, false);
			return {success:false,error:'Synthetic final failure'};
		},
	});
	try {
		await h.api.toggleRealtimeVoice(); await h.api.toggleRealtimeVoice();
		h.emit({type:'context.request',requestId:'expanded',beforeChars:6000,afterChars:6000});
		await tick(); await tick();
		h.emit({type:'transcript.final',text:'Complete transcript.'});
		h.emit({type:'error',error:'LLM unavailable'});
		await tick(); await tick();
		await h.api.retryVoiceProcessing(h.calls.find(c=>c.command==='voice_stream_open').args.id);
		assert.equal(h.calls.filter(c=>c.command==='voice_preferences_request').length,1);
	} finally {h.dispose();}
});
test('server recording limit stops the mic, drains audio and applies the final result', async () => {
	const h = harness();
	try {
		await h.api.toggleRealtimeVoice();
		h.frame();
		h.emit({
			type: 'assistant.message',
			kind: 'recording_limit',
			revision: 0,
			text: '30 seconds left',
		});
		h.emit({ type: 'session.stopping', text: 'Recording limit reached' });
		await tick();
		await tick();
		const stopIndex = h.calls.findIndex((c) => c.command === 'microphone.stop');
		const stopSend = h.calls.findIndex(
			(c) =>
				c.command === 'voice_stream_send' &&
				JSON.parse(c.args.message).type === 'session.stop',
		);
		assert.ok(stopIndex >= 0 && stopSend > stopIndex);
		assert.ok(
			h.calls
				.slice(0, stopSend)
				.some(
					(c) =>
						c.command === 'voice_stream_send' &&
						JSON.parse(c.args.message).type === 'audio.chunk',
				),
		);
		h.emit({ type: 'transcript.final', text: 'Complete speech', revision: 1 });
		h.emit({ type: 'processing.final_text', finalText: 'Complete result' });
		await tick();
		assert.ok(
			h.calls.some(
				(c) =>
					c.command === 'voice_target_apply' &&
					c.args.text === 'Complete result',
			),
		);
		assert.ok(
			h.calls.some(
				(c) =>
					c.command === 'history.event' &&
					c.args[1] === 'recording.limit_warning',
			),
		);
		assert.ok(
			!h.calls.some(
				(c) =>
					c.command === 'history.event' && c.args[1] === 'assistant.message',
			),
		);
	} finally {
		h.dispose();
	}
});

test('does not open the microphone until token refresh succeeds', async () => {
	let releaseToken;
	const h = harness(undefined, {
		delayReady: true,
		token: () =>
			new Promise((resolve) => {
				releaseToken = resolve;
			}),
	});
	try {
		const starting = h.api.toggleRealtimeVoice();
		await tick();
		assert.ok(!h.calls.some((c) => c.command === 'microphone'));
		assert.ok(h.calls.some((c) => c.command === 'token'));
		releaseToken('fresh');
		await tick();
		assert.ok(h.calls.some((c) => c.command === 'microphone'));
		h.frame();
		h.frame();
		h.frame();
		const stopping = h.api.toggleRealtimeVoice();
		await tick();
		assert.ok(h.calls.some((c) => c.command === 'microphone.stop'));
		assert.equal(
			h.calls.filter((c) => c.command === 'voice_stream_send').length,
			1, // session.start is sent; audio still waits for session.started.
		);
		h.emit({ type: 'session.started' });
		await starting;
		await stopping;
		const sent = h.calls.filter((c) => c.command === 'voice_stream_send');
		assert.deepEqual(
			sent.map((c) => JSON.parse(c.args.message).type),
			[
				'session.start',
				'audio.chunk',
				'audio.chunk',
				'audio.chunk',
				'session.stop',
			],
		);
		await h.api.cancelRealtimeVoice();
	} finally {
		h.dispose();
	}
});

test('missing login ends startup without recording audio or opening a stream', async () => {
	const h = harness(undefined, { token: () => null });
	try {
		await h.api.toggleRealtimeVoice();
		assert.equal(h.calls.filter((c) => c.command === 'microphone').length, 0);
		assert.equal(
			h.calls.filter((c) => c.command === 'voice_target_capture').length,
			1,
		);
		assert.equal(
			h.calls.filter(
				(c) =>
					c.command === 'voice_stream_send' &&
					JSON.parse(c.args.message).type === 'audio.chunk',
			).length,
			0,
		);
		assert.ok(!h.calls.some(c => c.command === 'voice_target_apply'));
	} finally {
		h.dispose();
	}
});

test('slow editor capture overlaps authorized microphone and backend startup, but gates context and overlay', async () => {
	let resolveCapture;
	const h = harness(
		() =>
			new Promise((resolve) => {
				resolveCapture = resolve;
			}),
	);
	try {
		const starting = h.api.toggleRealtimeVoice();
		await tick();
		assert.ok(h.calls.some((c) => c.command === 'microphone'));
		assert.ok(h.calls.some((c) => c.command === 'voice_stream_open'));
		assert.ok(!h.calls.some((c) => c.command === 'show_recording_overlay'));
		assert.ok(!h.calls.some((c) => c.command === 'voice_stream_send'));
		h.frame();
		await h.api.toggleRealtimeVoice();
		assert.ok(h.calls.some((c) => c.command === 'microphone.stop'));
		resolveCapture(undefined);
		await starting;
		await tick();
		const sent = h.calls
			.filter((c) => c.command === 'voice_stream_send')
			.map((c) => JSON.parse(c.args.message).type);
		assert.deepEqual(sent, ['session.start', 'audio.chunk', 'session.stop']);
		await h.api.cancelRealtimeVoice();
	} finally {
		h.dispose();
	}
});

test('microphone permission prompts wait for pending editor capture', async () => {
	let resolveCapture;
	const h = harness(
		() =>
			new Promise((resolve) => {
				resolveCapture = resolve;
			}),
		{ permission: 'prompt' },
	);
	try {
		const starting = h.api.toggleRealtimeVoice();
		await tick();
		assert.ok(h.calls.some((c) => c.command === 'voice_stream_open'));
		assert.ok(!h.calls.some((c) => c.command === 'microphone'));
		resolveCapture(undefined);
		await starting;
		await h.api.cancelRealtimeVoice();
	} finally {
		h.dispose();
	}
});

test('401 forces refresh once without restarting microphone capture', async () => {
	let attempts = 0;
	const h = harness(undefined, {
		open: () => {
			if (++attempts === 1) throw new Error('HTTP 401 Unauthorized');
		},
	});
	try {
		await h.api.toggleRealtimeVoice();
		assert.equal(attempts, 2);
		assert.equal(h.calls.filter((c) => c.command === 'microphone').length, 1);
		assert.deepEqual(
			h.calls.filter((c) => c.command === 'token').map((c) => c.force),
			[undefined, true],
		);
		await h.api.cancelRealtimeVoice();
	} finally {
		h.dispose();
	}
});

test('cancelled capture cannot reopen transport after another session starts', async () => {
	let resolveCapture;
	let captures = 0;
	const h = harness(() =>
		++captures === 1
			? new Promise((resolve) => {
					resolveCapture = resolve;
				})
			: undefined,
	);
	try {
		const old = h.api.toggleRealtimeVoice();
		await h.api.cancelRealtimeVoice();
		await h.api.toggleRealtimeVoice();
		resolveCapture(undefined);
		await old;
		assert.equal(
			h.calls.filter((call) => call.command === 'voice_stream_open').length,
			1,
		);
		await h.api.cancelRealtimeVoice();
	} finally {
		h.dispose();
	}
});
test('duplicate final results and normal close apply the edit only once', async () => {
	const h = harness();
	try {
		await h.api.toggleRealtimeVoice();
		h.emit({ type: 'processing.final_text', finalText: 'Hello' });
		h.emit({ type: 'processing.final_text', finalText: 'Hello' });
		h.emit({ type: 'transport.closed' });
		await tick();
		assert.equal(
			h.calls.filter((call) => call.command === 'voice_target_apply').length,
			1,
		);
		assert.equal(h.messages.length, 1);
		assert.equal(h.messages[0].title, 'Voice text applied');
	} finally {
		h.dispose();
	}
});
test('transport failure never applies a partial transcript', async () => {
	const h = harness();
	try {
		await h.api.toggleRealtimeVoice();
		h.emit({ type: 'transcript.partial', text: 'unfinished', revision: 1 });
		h.emit({ type: 'transport.closed' });
		await tick();
		assert.equal(
			h.calls.filter((call) => call.command === 'voice_target_apply').length,
			0,
		);
		assert.equal(h.messages[0].title, 'Voice session stopped');
	} finally {
		h.dispose();
	}
});

test('insertion errors remain visible with the generated result preserved', async () => {
	const h = harness(undefined, {
		apply: () => {
			throw 'Focus moved to another field; result was not inserted';
		},
	});
	try {
		await h.api.toggleRealtimeVoice();
		h.emit({ type: 'processing.final_text', finalText: 'Keep this result' });
		await tick();
		const updates = h.calls.filter(
			(call) => call.command === 'voice_overlay_update',
		);
		assert.ok(JSON.stringify(updates).includes('Focus moved to another field'));
		assert.ok(JSON.stringify(updates).includes('Keep this result'));
		assert.equal(h.messages[0].title, 'Voice text ready — copy to your field');
	} finally {
		h.dispose();
	}
});

test('reuses the audio runtime while stopping hardware capture between recordings', async () => {
	const h = harness();
	try {
		await h.api.toggleRealtimeVoice();
		await h.api.cancelRealtimeVoice();
		await h.api.toggleRealtimeVoice();
		assert.equal(h.calls.filter((c) => c.command === 'audio.create').length, 1);
		assert.equal(h.calls.filter((c) => c.command === 'audio.module').length, 1);
		assert.equal(h.calls.filter((c) => c.command === 'microphone').length, 2);
		assert.equal(
			h.calls.filter((c) => c.command === 'microphone.stop').length,
			1,
		);
		await h.api.cancelRealtimeVoice();
		assert.equal(
			h.calls.filter((c) => c.command === 'microphone.stop').length,
			2,
		);
	} finally {
		h.dispose();
	}
});

test('provider setup proceeds while microphone initialization is pending', async () => {
	let releaseMicrophone;
	const h = harness(undefined, {
		microphone: () =>
			new Promise((resolve) => {
				releaseMicrophone = resolve;
			}),
	});
	try {
		const starting = h.api.toggleRealtimeVoice();
		await tick();
		assert.ok(h.calls.some((c) => c.command === 'voice_stream_open'));
		assert.ok(
			h.calls.some(
				(c) =>
					c.command === 'voice_stream_send' &&
					JSON.parse(c.args.message).type === 'session.start',
			),
		);
		assert.ok(!h.calls.some((c) => c.command === 'show_recording_overlay'));
		releaseMicrophone();
		await starting;
		await h.api.cancelRealtimeVoice();
	} finally {
		h.dispose();
	}
});

test('first-time microphone permission never leaves a provider waiting for audio', async () => {
	let releaseMicrophone;
	const h = harness(undefined, {
		permission: 'prompt',
		microphone: () =>
			new Promise((resolve) => {
				releaseMicrophone = resolve;
			}),
	});
	try {
		const starting = h.api.toggleRealtimeVoice();
		await tick();
		assert.ok(h.calls.some((c) => c.command === 'voice_stream_open'));
		assert.ok(!h.calls.some((c) => c.command === 'voice_stream_send'));
		releaseMicrophone();
		await starting;
		assert.ok(
			h.calls.some(
				(c) =>
					c.command === 'voice_stream_send' &&
					JSON.parse(c.args.message).type === 'session.start',
			),
		);
		await h.api.cancelRealtimeVoice();
	} finally {
		h.dispose();
	}
});

test('cancel during microphone initialization closes late tracks without starting capture', async () => {
	let releaseMicrophone;
	const h = harness(undefined, {
		microphone: () =>
			new Promise((resolve) => {
				releaseMicrophone = resolve;
			}),
	});
	try {
		const starting = h.api.toggleRealtimeVoice();
		await tick();
		await h.api.cancelRealtimeVoice();
		releaseMicrophone();
		await starting;
		assert.equal(
			h.calls.filter((c) => c.command === 'microphone.stop').length,
			1,
		);
		assert.ok(!h.calls.some((c) => c.command === 'show_recording_overlay'));
		assert.ok(!h.calls.some((c) => c.command === 'voice_target_apply'));
	} finally {
		h.dispose();
	}
});

test('context expansion sends bounded original context and restores distant text with the returned caret', async () => {
	const before = 'A'.repeat(9000);
	const after = 'Z'.repeat(9000);
	const h = harness(() => ({
		fullText: before + after,
		textBeforeCursor: before,
		selectedText: '',
		textAfterCursor: after,
		packageName: 'fixture',
		identity: 'private',
	}));
	try {
		await h.api.toggleRealtimeVoice();
		const sent = () =>
			h.calls
				.filter((c) => c.command === 'voice_stream_send')
				.map((c) => JSON.parse(c.args.message));
		const initial = sent().find((e) => e.type === 'session.start').payload
			.context;
		assert.equal(initial.fullText.length, 4000);
		assert.equal(initial.identity, undefined);
		await h.api.toggleRealtimeVoice();
		h.emit({
			type: 'context.request',
			requestId: 'more1',
			beforeChars: 6000,
			afterChars: 6000,
		});
		await tick();
		const reply = sent().find((e) => e.type === 'context.provide');
		assert.equal(reply.payload.context.fullText.length, 12000);
		assert.equal(reply.payload.context.contextWindow.start, 3000);
		assert.ok(
			h.calls.some(
				(c) =>
					c.command === 'voice_overlay_update' &&
					c.args.data.phase === 'processing' &&
					c.args.data.statusText === 'Gathering more context…',
			),
		);
		h.emit({
			type: 'processing.final_text',
			finalText: `${'A'.repeat(6000)} inserted ${'Z'.repeat(6000)}`,
			cursorPosition: 6010,
		});
		await tick();
		const apply = h.calls.find((c) => c.command === 'voice_target_apply');
		assert.equal(apply.args.text, `${before} inserted ${after}`);
		assert.equal(apply.args.cursorPosition, 9010);
		const result = h.calls.find(
			(c) => c.command === 'history.event' && c.args[1] === 'llm.result',
		);
		assert.equal(result.args[3].result.length, 12010);
	} finally {
		h.dispose();
	}
});

test('a final result for a different context window is never applied', async () => {
	const h = harness();
	try {
		await h.api.toggleRealtimeVoice();
		await h.api.toggleRealtimeVoice();
		h.emit({
			type: 'processing.final_text',
			finalText: 'wrong',
			cursorPosition: 5,
			contextWindow: {
				start: 1,
				totalLength: 5,
				hasBefore: true,
				hasAfter: false,
			},
		});
		await tick();
		assert.ok(!h.calls.some((c) => c.command === 'voice_target_apply'));
		assert.ok(
			h.messages.some((m) =>
				JSON.stringify(m).includes('different context window'),
			),
		);
	} finally {
		h.dispose();
	}
});

test('context expansion refuses unbounded requests and never recaptures another field', async () => {
	const h = harness();
	try {
		await h.api.toggleRealtimeVoice();
		await h.api.toggleRealtimeVoice();
		h.emit({
			type: 'context.request',
			requestId: 'too-large',
			beforeChars: 900000,
			afterChars: 2000,
		});
		await tick();
		const reply = h.calls
			.filter((c) => c.command === 'voice_stream_send')
			.map((c) => JSON.parse(c.args.message))
			.find((e) => e.type === 'context.provide');
		assert.match(reply.payload.error, /window/);
		assert.equal(reply.payload.context, undefined);
		assert.equal(
			h.calls.filter((c) => c.command === 'voice_target_capture').length,
			1,
		);
		await h.api.cancelRealtimeVoice();
	} finally {
		h.dispose();
	}
});

test('history keeps ASR revisions, LLM output and the insertion failure', async () => {
	const h = harness(undefined, {
		apply: () => {
			throw 'Field changed';
		},
	});
	try {
		await h.api.toggleRealtimeVoice();
		h.emit({ type: 'transcript.partial', text: 'Hello', revision: 1 });
		h.emit({ type: 'transcript.final', text: 'Hello world', revision: 2 });
		const usage = {
			summary: '100 input / 20 output tokens',
			calls: [{ inputTokens: 100, outputTokens: 20 }],
		};
		h.emit({ type: 'usage.updated', usage });
		h.emit({ type: 'processing.final_text', finalText: 'Hello, world.' });
		await tick();
		const events = h.calls.filter((call) => call.command === 'history.event');
		assert.ok(
			events.some(
				(call) =>
					call.args[1] === 'usage.updated' && call.args[3].usage === usage,
			),
		);
		assert.ok(
			events.some(
				(call) =>
					call.args[1] === 'transcript.partial' && call.args[2] === 'Hello',
			),
		);
		assert.ok(
			events.some(
				(call) =>
					call.args[1] === 'transcript.final' && call.args[2] === 'Hello world',
			),
		);
		assert.ok(
			events.some(
				(call) =>
					call.args[1] === 'llm.result' &&
					call.args[3].result === 'Hello, world.',
			),
		);
		assert.ok(
			events.some(
				(call) =>
					call.args[1] === 'insertion.failed' &&
					call.args[2] === 'Field changed',
			),
		);
	} finally {
		h.dispose();
	}
});
