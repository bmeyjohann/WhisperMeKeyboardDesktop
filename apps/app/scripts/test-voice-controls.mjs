import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

async function load(path, require = () => ({}), globals = {}) {
	const exports = {};
	runInNewContext(ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, {exports, require, performance, TextEncoder, ...globals});
	return exports;
}
const {createTapHoldShortcut} = await load('../src/lib/services/tap-hold-shortcut.ts');
const routing = await load('../src/lib/constants/transcription/backend-provider-config.ts');
const contract = await load('../src/lib/services/preference-contract.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));

function budgetStore(initial) {
	let value = initial;
	return {get value() {return value;}, set: next => {value = next;}, update: fn => {value = fn(value);}};
}
test('HTTP budget notices persist only public budget fields and clear on a below-threshold response', async () => {
	const saved = new Map();
	const localStorage = {getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key)};
	const require = () => ({writable: budgetStore});
	const feedback = await load('../src/lib/services/voice-feedback.ts', require, {localStorage});
	const budget = {warning: true, committedUsd: 8.12, limitUsd: 10, resetsAt: '2099-10-01T00:00:00.000Z', token: 'must-not-persist'};
	assert.match(feedback.reportBudgetStatus(budget), /\$8\.12 of \$10\.00/);
	assert.doesNotMatch([...saved.values()][0], /token|must-not-persist/);
	const restarted = await load('../src/lib/services/voice-feedback.ts', require, {localStorage});
	assert.match(restarted.voiceBudgetWarning.value, /2099-10-01/);
	restarted.reportBudgetStatus({...budget, warning: false});
	assert.equal(restarted.voiceBudgetWarning.value, ''); assert.equal(saved.size, 0);
});
test('advanced batch HTTP response publishes and saves its budget warning', async () => {
	const feedback = await load('../src/lib/services/voice-feedback.ts', () => ({writable: budgetStore}));
	const records = [];
	const response = {success: true, transcription: {text: 'Speech'}, finalText: 'Speech.', budget: {warning: true, committedUsd: 8, limitUsd: 10, resetsAt: '2099-10-01T00:00:00Z'}};
	const modules = {
		'../voice-feedback': feedback,
		'$lib/stores/settings.svelte': {settings: {value: {}}},
		'$lib/constants/transcription/backend-provider-config': routing,
		'@tauri-apps/api/core': {invoke: async command => command === 'gather_context' ? {packageName: 'fixture'} : response},
		'../auth0': {auth0Service: {getAccessToken: async () => 'synthetic'}},
		'../voice-history': {beginVoiceHistory() {}, recordVoiceHistory: (...args) => records.push(args), safeVoiceRecovery: value => value},
		'../style-profile': {},
		'../preference-contract': contract,
		'../preference-drafts': {receivePreferenceSuggestions: () => 0, rememberVoiceApp() {}},
		'wellcrafted/result': {Ok: data => ({data}), Err: error => ({error}), tryAsync: async ({try: run, mapError}) => {try {return {data: await run()};} catch (error) {return {error: mapError(error)};}}},
	};
	const adapter = await load('../src/lib/services/transcription/whisperme.ts', name => modules[name], {crypto: {randomUUID: () => 'batch'}, Uint8Array});
	const result = await adapter.createWhisperMeTranscriptionService().transcribe(new Blob(['synthetic audio']));
	assert.equal(result.data, 'Speech.');
	assert.match(feedback.voiceBudgetWarning.value, /\$8\.00 of \$10\.00/);
	assert.ok(records.some(record => record[1] === 'budget.warning' && record[3].budgetWarning));
});

test('batch carries opt-in hints and consumes standalone drafts without returning insertion text', async () => {
	for (const requiresConfirmation of [true, false]) {
		const records = [], calls = [];
		const settings = {value:{'voiceInput.dictionary':['MEYJOHANN'], 'voiceInput.useDictionary':true, 'voiceInput.suggestPreferences':true, 'voiceInput.appCategories':[{app:'editor.exe',category:'business'}], 'voiceInput.preferenceDrafts':[]}};
		const response = {success:true,finalText:'MEYJOHANN',preferenceSuggestion:{kind:'dictionary',text:'MEYJOHANN',requiresConfirmation}};
		const modules = {
			'../voice-feedback': await load('../src/lib/services/voice-feedback.ts', () => ({writable:budgetStore})),
			'$lib/stores/settings.svelte':{settings}, '$lib/constants/transcription/backend-provider-config':routing,
			'@tauri-apps/api/core':{invoke:async (command,args) => {calls.push({command,args});return command === 'gather_context' ? {packageName:'editor.exe'} : response;}},
			'../auth0':{auth0Service:{getAccessToken:async () => 'synthetic'}},
			'../voice-history':{beginVoiceHistory() {},recordVoiceHistory:(...args) => records.push(args),safeVoiceRecovery:value => value},
			'../preference-contract':contract, '../style-profile':{},
			'wellcrafted/result':{Ok:data => ({data}),Err:error => ({error}),tryAsync:async ({try:run,mapError}) => {try {return {data:await run()};} catch (error) {return {error:mapError(error)};}}},
		};
		modules['../preference-drafts'] = await load('../src/lib/services/preference-drafts.ts', key => ({'./preference-contract':contract,'$lib/stores/settings.svelte':{settings}}[key]), {crypto:{randomUUID:() => 'draft'}});
		const adapter = await load('../src/lib/services/transcription/whisperme.ts', key => modules[key], {crypto:{randomUUID:() => 'batch'},Uint8Array});
		const result = await adapter.createWhisperMeTranscriptionService().transcribe(new Blob(['synthetic audio']));
		assert.equal(result.data, requiresConfirmation ? '' : 'MEYJOHANN');
		const request = calls.find(call => call.command === 'process_voice_with_backend').args;
		assert.deepEqual(JSON.parse(JSON.stringify(request.dictionary)), ['MEYJOHANN']); assert.equal(request.suggestPreferences,true); assert.equal(request.appCategory,'business');
		assert.equal(settings.value['voiceInput.preferenceDrafts'].length,1);
		assert.equal(calls.some(call => call.command === 'voice_preferences_request'),false);
	}
});
test('empty notice-only delivery never copies or pastes text', async () => {
	const calls = [], notices = [];
	const modules = {'$lib/toast':{toast:{success:value => notices.push(value)}},'$lib/constants/app':{},'./query':{rpc:{clipboard:{copyToClipboard:{execute:async () => calls.push('copy')},writeTextToCursor:{execute:async () => calls.push('paste')}}}},'$lib/stores/settings.svelte':{settings:{value:{'transcription.clipboard.copyOnSuccess':true,'transcription.clipboard.pasteOnSuccess':true}}}};
	const delivery = await load('../src/lib/deliverTextToUser.ts', key => modules[key]);
	await delivery.deliverTranscribedText({text:'',toastId:'notice'});
	assert.deepEqual(calls,[]); assert.equal(notices[0].action.goto,'/settings/transcription');
});
test('tap toggles, key repeat is ignored, and a short release keeps recording', async () => {
	let time = 0, active = false, toggles = 0, finishes = 0;
	const shortcut = createTapHoldShortcut(async () => {toggles++; active = !active; return active;}, async () => {finishes++; active = false;}, () => time);
	shortcut('Pressed'); shortcut('Pressed'); await tick();
	time = 999; shortcut('Released'); await tick();
	assert.equal(active, true); assert.equal(toggles, 1); assert.equal(finishes, 0);
	shortcut('Pressed'); await tick(); time = 2500; shortcut('Released'); await tick();
	assert.equal(active, false); assert.equal(toggles, 2); assert.equal(finishes, 0);
});
test('one second hold finishes once even when released during asynchronous startup', async () => {
	let time = 0, start, finishes = 0;
	const shortcut = createTapHoldShortcut(() => new Promise(resolve => {start = resolve;}), async () => {finishes++;}, () => time);
	shortcut('Pressed'); await tick(); time = 1000; shortcut('Released'); shortcut('Released'); await tick();
	assert.equal(finishes, 0); start(true); await tick(); assert.equal(finishes, 1);
});
test('failed asynchronous start never finishes or starts another recording on release', async () => {
	let time = 0, finishes = 0;
	const shortcut = createTapHoldShortcut(async () => false, async () => {finishes++;}, () => time);
	shortcut('Pressed'); await tick(); time = 1000; shortcut('Released'); await tick(); assert.equal(finishes, 0);
});
test('routing migration omits pinned provider/model and default reasoning but preserves explicit overrides', () => {
	assert.equal(JSON.stringify(routing.llmRoutingOptions(undefined, 'cerebras_glm_4_7', 'gemma-4-31b')), JSON.stringify({llmRouting: 'server', llmProvider: 'default'}));
	const explicit = routing.llmRoutingOptions('explicit', 'cerebras_glm_4_7', 'gemma-4-31b', 'none');
	assert.equal(explicit.llmModel, 'gemma-4-31b'); assert.equal(explicit.reasoningEffort, 'none');
	assert.equal(routing.llmRoutingOptions('explicit', 'groq_kimi_k2', 'openai/gpt-oss-120b', 'none').reasoningEffort, undefined);
	for (const effort of ['low', 'medium', 'high']) assert.equal(routing.llmRoutingOptions('explicit', 'groq_kimi_k2', 'openai/gpt-oss-120b', effort).reasoningEffort, effort);
	assert.equal(routing.llmRoutingOptions('server', 'groq_kimi_k2', '', 'garbage').reasoningEffort, undefined);
});
test('local shortcut release survives modifier-first release and focus moving into an editor', async () => {
	const handlers = new Map(), events = [];
	const window = {}, document = {activeElement: null, visibilityState: 'visible'};
	const manager = await load('../src/lib/services/local-shortcut-manager.ts', name => ({
		'$lib/constants/keyboard': {isSupportedKey: key => ['control', 'r'].includes(key)},
		'$lib/constants/platform': {IS_MACOS: false},
		'svelte/events': {on: (_, event, fn) => {handlers.set(event, fn); return () => handlers.delete(event);}},
		'wellcrafted/result': {Ok: data => ({data})},
	}[name]), {window, document});
	const service = manager.createLocalShortcutManager();
	await service.register({id: 'record', keyCombination: ['control', 'r'], on: 'Both', callback: event => events.push(event)});
	service.listen();
	const key = (type, key) => handlers.get(type)({key, preventDefault() {}});
	key('keydown', 'Control'); key('keydown', 'r'); key('keydown', 'r');
	document.activeElement = {tagName: 'TEXTAREA'};
	key('keyup', 'Control'); key('keyup', 'r');
	assert.deepEqual(events, ['Pressed', 'Released']);
});
