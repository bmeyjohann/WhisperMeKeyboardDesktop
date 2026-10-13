import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source = await readFile(
	new URL('../src/lib/services/auth0.ts', import.meta.url),
	'utf8',
);
const compiled = ts.transpileModule(source, {
	compilerOptions: {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES2022,
	},
}).outputText;
function harness(expiration, response, refreshToken = 'refresh', options = {}) {
	let stored = {
		access_token: 'old',
		refresh_token: refreshToken,
		expiration_time: expiration,
		id_token: 'x.eyJzdWIiOiJ0ZXN0In0.x',
	};
	let refreshes = 0;
	const probes = [];
	const grants = [];
	const logs = [];
	const timers = new Map();
	const settings = { value: { 'voiceInput.endpoint': 'wss://configured.example/realtime' } };
	const writable = (initial) => {
		let value = initial;
		const listeners = new Set();
		return {
			set(next) {
				value = next;
				for (const listener of listeners) listener(value);
			},
			subscribe(listener) {
				listeners.add(listener);
				listener(value);
				return () => listeners.delete(listener);
			},
		};
	};
	const modules = {
		'svelte/store': { writable },
		'@tauri-apps/api/core': {
			invoke: async (command, args) => {
				if (command === 'auth0_token_request') {
					grants.push(args.grant);
					refreshes++;
					await new Promise((resolve) => setImmediate(resolve));
					const result = options.refresh ? await options.refresh(args.grant) : response;
					return { status: result.status ?? (result.ok ? 200 : 500), payload: await result.json() };
				}
				if (command === 'voice_local_mode') return options.localMode?.() ?? false;
				if (command === 'voice_backend_status') {
					probes.push(args);
					return options.probe ? options.probe(args, probes.length) : {};
				}
				if (command === 'get_stored_tokens')
					return stored ? JSON.stringify(stored) : null;
				if (command === 'store_tokens') stored = JSON.parse(args.tokens);
				if (command === 'clear_stored_tokens') stored = null;
				if (command === 'js_log') logs.push(args.message);
			},
		},
		'@tauri-apps/plugin-shell': {},
		'@tauri-apps/plugin-http': {
			fetch: async (...args) => {
				refreshes++;
				await new Promise((resolve) => setImmediate(resolve));
				return options.refresh ? options.refresh(...args) : response;
			},
		},
		'crypto-js': {},
		'$lib/stores/settings.svelte': { settings },
	};
	const exports = {};
	runInNewContext(compiled, {
		exports,
		require: (name) => modules[name],
		URLSearchParams,
		AbortController,
		atob,
		console,
		setTimeout: (callback, delay) => {
			const timer = setTimeout(callback, options.timeoutMs ?? delay);
			timers.set(timer, delay);
			return timer;
		},
		clearTimeout: (timer) => { timers.delete(timer); clearTimeout(timer); },
	});
	return { service: exports.auth0Service, refreshes: () => refreshes, stored: () => stored,
		probes, grants, settings, logs, timers };
}
function value(store) { let result; store.subscribe(v => result = v)(); return result; }
test('startup exposes reauthentication without beginning a recording', async () => {
	const h = harness(1, { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
	assert.equal(await h.service.checkSession(), false);
	assert.equal(value(h.service.isAuthenticated), false);
	assert.match(value(h.service.error), /sign in before recording/i);
	assert.equal(value(h.service.sessionChecking), false);
});
test('missing refresh token clears stale authenticated UI', async () => {
	const h = harness(1, {}, undefined);
	// Explicitly remove it; an undefined argument uses the harness default.
	delete h.stored().refresh_token;
	assert.equal(await h.service.checkSession(), false);
	assert.match(value(h.service.error), /sign in before recording/i);
	assert.equal(h.stored(), null);
});
test('missing refresh token stops repeated timer, focus and forced refresh attempts until new login', async () => {
	const h = harness(1, refreshed, '');
	assert.equal(await h.service.checkSession(), false);
	const message = value(h.service.error);
	assert.match(message, /no refresh token was issued/i);
	const logCount = h.logs.length;
	for (let i = 0; i < 5; i++) {
		assert.equal(await h.service.checkSession(), false);
		assert.equal(await h.service.getAccessToken(), null);
		assert.equal(await h.service.refreshToken(), null);
	}
	assert.equal(h.logs.length, logCount);
	assert.equal(h.refreshes(), 0);
	assert.equal(value(h.service.error), message);
	// Exercise the successful authorization-code exchange that ends the signed-out state.
	await h.service.exchangeCodeForTokens('synthetic-code', 'synthetic-verifier');
	assert.equal(await h.service.getAccessToken(), 'new');
	assert.equal(value(h.service.isAuthenticated), true);
	assert.equal(h.grants[0].grant_type, 'authorization_code');
	assert.equal(h.grants[0].code_verifier, 'synthetic-verifier');
});
test('temporary server failure keeps credentials for retry', async () => {
	const h = harness(1, { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) });
	assert.equal(await h.service.checkSession(), false);
	assert.equal(h.stored().refresh_token, 'refresh');
	assert.match(value(h.service.error), /connection and retry/i);
});
test('startup and concurrent access refresh an expired token once', async () => {
	const h = harness(1, {
		ok: true,
		json: async () => ({ access_token: 'new', expires_in: 3600 }),
	});
	assert.deepEqual(
		await Promise.all([h.service.getAccessToken(), h.service.getAccessToken()]),
		['new', 'new'],
	);
	assert.equal(h.refreshes(), 1);
	assert.equal(h.grants[0].grant_type, 'refresh_token');
});
test('invalid_grant never returns an expired token', async () => {
	const h = harness(1, {
		ok: false,
		status: 400,
		json: async () => ({ error: 'invalid_grant' }),
	});
	assert.equal(await h.service.getAccessToken(), null);
});
test('forced refresh replaces even an unexpired rejected token and deduplicates callers', async () => {
	const h = harness(Date.now() + 3600000, {
		ok: true,
		json: async () => ({ access_token: 'new', expires_in: 3600 }),
	});
	assert.equal(await h.service.getAccessToken(), 'old');
	assert.deepEqual(
		await Promise.all([h.service.refreshToken(), h.service.refreshToken()]),
		['new', 'new'],
	);
	assert.equal(h.refreshes(), 1);
});

const refreshed = { ok: true, json: async () => ({ access_token: 'new', expires_in: 3600 }) };
const future = () => Date.now() + 3600000;
const rejected = () => { throw 'Backend returned 401 Unauthorized'; };

test('startup, focus and recording share a preflight against the current configured endpoint', async () => {
	let release;
	const h = harness(future(), refreshed, 'refresh', {
		probe: () => new Promise(resolve => { release = resolve; }),
	});
	const checks = Promise.all([h.service.checkSession(), h.service.checkVoiceSession(), h.service.getVoiceAccessToken()]);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(value(h.service.sessionChecking), true);
	assert.equal(h.probes.length, 1);
	assert.equal(h.probes[0].endpoint, h.settings.value['voiceInput.endpoint']);
	assert.equal(h.probes[0].token, 'old');
	release({});
	assert.deepEqual(await checks, [true, true, 'old']);
	assert.equal(h.timers.size, 0);
	assert.equal(value(h.service.sessionChecking), false);
	h.settings.value['voiceInput.endpoint'] = 'wss://changed.example/realtime';
	const next = h.service.checkSession();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(h.probes[1].endpoint, 'wss://changed.example/realtime');
	release({});
	assert.equal(await next, true);
});

test('unexpired token rejected by voice backend is refreshed once and rechecked', async () => {
	const h = harness(future(), refreshed, 'refresh', {
		probe: ({ token }) => token === 'old' ? rejected() : {},
	});
	assert.deepEqual(await Promise.all([h.service.checkSession(), h.service.getVoiceAccessToken()]), [true, 'new']);
	assert.deepEqual(h.probes.map(p => p.token), ['old', 'new']);
	assert.equal(h.refreshes(), 1);
});

test('second backend 401 clears unusable credentials and requires sign in', async () => {
	const h = harness(future(), refreshed, 'refresh', { probe: rejected });
	assert.equal(await h.service.checkSession(), false);
	assert.equal(h.refreshes(), 1);
	assert.equal(h.probes.length, 2);
	assert.equal(h.stored(), null);
	assert.equal(value(h.service.isAuthenticated), false);
	assert.equal(value(h.service.accessToken), null);
	assert.match(value(h.service.error), /sign in before recording/i);
	assert.equal(await h.service.getVoiceAccessToken(), null);
});

test('forced preflight refreshes only once even when the replacement is rejected', async () => {
	const h = harness(future(), refreshed, 'refresh', { probe: rejected });
	assert.equal(await h.service.getVoiceAccessToken(true), null);
	assert.equal(h.refreshes(), 1);
	assert.equal(h.probes.length, 1);
	assert.equal(h.probes[0].token, 'new');
});

for (const failure of ['Backend returned 503 Service Unavailable', 'Backend returned 403 Forbidden', 'network failure with sensitive old token']) {
	test(`backend failure remains retryable: ${failure.split(' ')[0]} ${failure.split(' ')[2]}`, async () => {
		let failing = true;
		const h = harness(future(), refreshed, 'refresh', { probe: () => {
			if (failing) throw failure;
			return {};
		} });
		assert.equal(await h.service.checkSession(), false);
		assert.equal(h.refreshes(), 0);
		assert.equal(h.stored().access_token, 'old');
		assert.equal(value(h.service.isAuthenticated), true);
		assert.match(value(h.service.error), /connection and retry/i);
		assert.equal(h.logs.some(log => log.includes(failure)), false);
		assert.equal(value(h.service.error).includes(failure), false);
		failing = false;
		assert.equal(await h.service.checkSession(), true);
		assert.equal(value(h.service.error), null);
	});
}

test('transient refresh failure after 401 retains credentials and blocks recording', async () => {
	const h = harness(future(), { ok: false, status: 503, json: async () => ({}) }, 'refresh', { probe: rejected });
	assert.equal(await h.service.getVoiceAccessToken(), null);
	assert.equal(h.refreshes(), 1);
	assert.equal(h.stored().refresh_token, 'refresh');
	assert.equal(value(h.service.isAuthenticated), true);
	assert.match(value(h.service.error), /connection and retry/i);
});

test('hung native refresh times out and keeps credentials for retry', async () => {
	const h = harness(future(), refreshed, 'refresh', { timeoutMs: 15, probe: rejected,
		refresh: () => {
			return { ok: true, json: () => new Promise(() => {}) };
		},
	});
	assert.equal(await h.service.getVoiceAccessToken(), null);
	assert.equal(h.grants.length, 1);
	assert.equal(h.stored().refresh_token, 'refresh');
	assert.match(value(h.service.error), /retry/i);
	assert.equal(h.timers.size, 0);
});

test('hung native preflight is bounded, releases dedupe and ignores late success', async () => {
	let release;
	let hanging = true;
	const h = harness(future(), refreshed, 'refresh', { timeoutMs: 15, probe: () =>
		hanging ? new Promise(resolve => { release = resolve; }) : {} });
	const pending = h.service.checkSession();
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual([...h.timers.values()], [5000]);
	assert.equal(await pending, false);
	assert.equal(h.timers.size, 0);
	assert.equal(h.stored().access_token, 'old');
	release({});
	await new Promise(resolve => setImmediate(resolve));
	assert.match(value(h.service.error), /retry/i);
	hanging = false;
	assert.equal(await h.service.checkSession(), true);
});

test('local bypass stays native and is revalidated before each use', async () => {
	let valid = true;
	const h = harness(future(), refreshed, 'refresh', { localMode: () => {
		if (!valid) throw new Error('Local test session expired');
		return true;
	} });
	assert.equal(await h.service.checkSession(), true);
	assert.equal(await h.service.getVoiceAccessToken(), 'local-native-session');
	assert.equal(await h.service.getAccessToken(), null);
	assert.equal(h.probes.length, 0);
	assert.equal(h.refreshes(), 0);
	valid = false;
	assert.equal(await h.service.checkSession(), false);
	assert.equal(await h.service.getVoiceAccessToken(), null);
});

for (const change of ['endpoint', 'logout']) {
	test(`${change} during preflight invalidates the result`, async () => {
		let release;
		const h = harness(future(), refreshed, 'refresh', { probe: () => new Promise(resolve => { release = resolve; }) });
		const pending = h.service.getVoiceAccessToken();
		await new Promise(resolve => setImmediate(resolve));
		if (change === 'logout') await h.service.logout();
		else h.settings.value['voiceInput.endpoint'] = 'wss://changed.example/realtime';
		release({});
		assert.equal(await pending, null);
	});
}
