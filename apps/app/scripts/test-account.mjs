import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const require = createRequire(import.meta.url);
async function load(name, modules = {}, globals = {}) {
	const exports = {};
	runInNewContext(
		ts.transpileModule(
			await readFile(
				new URL(`../src/lib/services/${name}.ts`, import.meta.url),
				'utf8',
			),
			{
				compilerOptions: {
					module: ts.ModuleKind.CommonJS,
					target: ts.ScriptTarget.ES2022,
				},
			},
		).outputText,
		{
			exports,
			require: (key) => modules[key] ?? require(key),
			URL,
			Response,
			AbortController,
			setTimeout,
			clearTimeout,
			...globals,
		},
	);
	return exports;
}
const contract = await load('account-contract');
const plain = (value) => JSON.parse(JSON.stringify(value));
const plan = {
	id: 'starter',
	name: 'Starter',
	amountCents: 999,
	currency: 'eur',
	interval: 'month',
	audioSeconds: 3600,
	processingStarts: 100,
	available: false,
};
const account = {
	id: 'test-account',
	access: { state: 'trial', allowed: true, enforcementEnabled: false },
	usage: {
		periodStart: '2026-10-01T00:00:00Z',
		periodEnd: '2026-11-01T00:00:00Z',
		audioSeconds: 10.5,
		audioSecondsLimit: 60,
		processingStarts: 1,
		processingStartsLimit: 5,
	},
	subscription: { source: 'none', status: 'none', canManage: false },
	onboarding: { version: 0, completed: false },
	canAdmin: false,
	checkoutAvailable: false,
};
const settings = {
	enforcementEnabled: false,
	checkoutEnabled: false,
	trialAudioSeconds: 300,
	trialProcessingStarts: 10,
	trialDays: 7,
	asrUsdPerMinute: 0.006,
	llmInputUsdPerMillion: 0.1,
	llmOutputUsdPerMillion: 0.3,
	monthlyBudgetUsd: 10,
	warningRatio: 0.8,
};
const costs = {
	month: '2026-10',
	knownUsd: 0.01,
	unknownSessions: 2,
	sessionCount: 3,
	audioSeconds: 10.5,
	processingStarts: 3,
};

test('account parser accepts fractional audio, strips extras and rejects missing/invalid usage instead of zero defaults', () => {
	assert.equal(
		contract.parseAccount({ success: true, account }).usage.audioSeconds,
		10.5,
	);
	assert.equal(
		contract.parseAccount({
			success: true,
			account: { ...account, token: 'excluded' },
		}).token,
		undefined,
	);
	for (const usage of [
		undefined,
		{ ...account.usage, audioSeconds: null },
		{ ...account.usage, audioSeconds: -1 },
		{ ...account.usage, periodEnd: 'invalid' },
	]) {
		assert.throws(() =>
			contract.parseAccount({ success: true, account: { ...account, usage } }),
		);
	}
	assert.throws(() =>
		contract.parseAccount({
			success: true,
			account: { ...account, canAdmin: 'true' },
		}),
	);
	assert.throws(() => contract.parseAccount({ success: false, account }));
});
test('public plan parser strips owner Stripe fields and rejects invalid money', () => {
	assert.deepEqual(
		plain(
			contract.parsePlans({
				success: true,
				plans: [{ ...plan, stripePriceId: 'price_secret' }],
			}),
		),
		[plan],
	);
	for (const amountCents of [-1, 0.1, Infinity, Number.MAX_SAFE_INTEGER + 1])
		assert.throws(() =>
			contract.parsePlans({ success: true, plans: [{ ...plan, amountCents }] }),
		);
});
test('admin costs preserve unknown sessions and null known costs without substituting zero', () => {
	const result = contract.parseAdminBilling({
		success: true,
		plans: [plan],
		settings,
		costs: { ...costs, knownUsd: null },
	});
	assert.equal(result.costs.knownUsd, null);
	assert.equal(result.costs.unknownSessions, 2);
	assert.throws(() =>
		contract.parseAdminBilling({
			success: true,
			plans: [],
			settings,
			costs: { ...costs, unknownSessions: undefined },
		}),
	);
});
test('pending reservations default to zero only when omitted and preserve reported outstanding work', () => {
	const payload = { success: true, plans: [plan], settings, costs };
	assert.equal(
		contract.parseAdminBilling(payload).costs.pendingReservations,
		0,
	);
	assert.equal(
		contract.parseAdminBilling({
			...payload,
			costs: { ...costs, pendingReservations: 4 },
		}).costs.pendingReservations,
		4,
	);
	for (const pendingReservations of [-1, 0.5, null, '4']) {
		assert.throws(() =>
			contract.parseAdminBilling({
				...payload,
				costs: { ...costs, pendingReservations },
			}),
		);
	}
});
test('draft config rejects duplicate IDs, fractions in limits, bad rates and warning ratios; disabled flags remain disabled', () => {
	assert.equal(
		contract.billingDraftSchema.parse({ plans: [plan], settings }).settings
			.checkoutEnabled,
		false,
	);
	for (const draft of [
		{ plans: [plan, plan], settings },
		{ plans: [{ ...plan, audioSeconds: 1.5 }], settings },
		{ plans: [plan], settings: { ...settings, asrUsdPerMinute: -1 } },
		{ plans: [plan], settings: { ...settings, warningRatio: 0 } },
		{ plans: [plan], settings: { ...settings, warningRatio: 1.1 } },
		{ plans: [{ ...plan, stripePriceId: 'sk_live_never' }], settings },
	])
		assert.equal(contract.billingDraftSchema.safeParse(draft).success, false);
});
test('money converts decimal strings exactly, including comma decimals; rejects ambiguous, unsafe and fractional cents', () => {
	for (const [input, expected] of [
		['19.99', 1999],
		['0.29', 29],
		['9,9', 990],
		['0', 0],
		[' 12.00 ', 1200],
	])
		assert.equal(contract.parseMoneyCents(input), expected);
	for (const input of [
		'',
		'-1',
		'1.234',
		'1,234.56',
		'1e3',
		'NaN',
		'Infinity',
		'9007199254740992',
	])
		assert.throws(() => contract.parseMoneyCents(input));
	assert.match(contract.formatMoney(1999, 'eur'), /19[.,]99/);
	assert.equal(contract.parseNonnegative('0.006'), 0.006);
	for (const input of ['', '-1', 'NaN', '1e3'])
		assert.throws(() => contract.parseNonnegative(input));
	assert.throws(() => contract.parseNonnegative('1.5', true));
});
test('billing URL opens only HTTPS exact Stripe checkout/portal hosts', () => {
	for (const input of [
		'https://checkout.stripe.com/c/pay/cs_test_example',
		'https://billing.stripe.com/p/session/test',
	])
		assert.equal(contract.stripeUrl(input), input);
	for (const input of [
		undefined,
		'javascript:alert(1)',
		'http://checkout.stripe.com/pay',
		'https://stripe.com/pay',
		'https://checkout.stripe.com.evil.test/pay',
		'https://evilcheckout.stripe.com/pay',
		'https://checkout.stripe.com@evil.test/pay',
		'https://user@checkout.stripe.com/pay',
		'https://checkout.stripe.com:444/pay',
		'https://checkout.stripe.com./pay',
		' https://checkout.stripe.com/pay',
		'https://checkout.stripe.com\\@evil.test/pay',
		'https://checkout.stripe.com/\nsecret',
	])
		assert.throws(() => contract.stripeUrl(input));
});
test('account base stays on configured secure Worker origin and rejects URL credentials and loopback HTTP', () => {
	assert.equal(
		contract.accountBaseUrl('wss://configured.example/realtime'),
		'https://configured.example',
	);
	for (const endpoint of [
		'ws://localhost:8787/realtime',
		'http://host/realtime',
		'wss://user:secret@host/realtime',
		'wss://host/realtime?token=secret',
		'wss://host/realtime#secret',
	])
		assert.throws(() => contract.accountBaseUrl(endpoint));
});
test('feedback allowlist drops transcripts, audio, credentials, paths and arbitrary diagnostics', () => {
	const input = {
		submissionId: '50ce2431-9945-420f-a05f-bd1bc52c9ef9',
		kind: 'bug',
		message: ' A problem ',
		transcript: 'private',
		audio: 'private',
		diagnostics: {
			platform: 'windows',
			appVersion: '7.0.0',
			token: 'secret',
			editorText: 'private',
			endpoint: 'private',
			screenshot: 'private',
		},
	};
	assert.deepEqual(plain(contract.safeFeedback(input)), {
		submissionId: input.submissionId,
		kind: 'bug',
		message: 'A problem',
		diagnostics: { platform: 'windows', appVersion: '7.0.0' },
	});
	for (const message of ['', ' ', 'x'.repeat(4001)])
		assert.throws(() => contract.safeFeedback({ ...input, message }));
});

function store(value) {
	return {
		subscribe(fn) {
			fn(value);
			return () => {};
		},
		set(next) {
			value = next;
		},
	};
}
async function harness(responses, options = {}) {
	const calls = [];
	const opened = [];
	const logs = [];
	let refreshes = 0;
	const user = store({ sub: 'test' });
	const authenticated = store(true);
	const auth = {
		user,
		isAuthenticated: authenticated,
		localTest: store(options.local ?? false),
		getAuthHeader: async () => 'Bearer synthetic-token',
		refreshToken: async () => {
			refreshes++;
			return options.failedRefresh ? null : 'refreshed';
		},
	};
	const config = {
		value: { 'voiceInput.endpoint': 'wss://configured.example/realtime' },
	};
	const fetch = async (url, init) => {
		calls.push({ url, init });
		return typeof responses === 'function'
			? responses(url, init)
			: responses.shift();
	};
	const http = await load(
		'httpClient',
		{ './auth0': { auth0Service: auth } },
		{ fetch, console: { error: (...args) => logs.push(args) } },
	);
	const api = await load(
		'account-api',
		{
			'svelte/store': {
				get: (s) => {
					let v;
					s.subscribe((value) => (v = value))();
					return v;
				},
			},
			'@tauri-apps/plugin-http': { fetch },
			'@tauri-apps/plugin-opener': { openUrl: async (url) => opened.push(url) },
			'./auth0': { auth0Service: auth },
			'./httpClient': http,
			'$lib/stores/settings.svelte': { settings: config },
			'./account-contract': contract,
		},
		{ fetch, window: { __TAURI_INTERNALS__: options.native ?? false } },
	);
	return {
		...api,
		calls,
		opened,
		logs,
		user,
		authenticated,
		config,
		refreshes: () => refreshes,
	};
}
const json = (body, status = 200) => Response.json(body, { status });
test('created price response must identify the saved unavailable draft and its returned Stripe price', () => {
	const payload = {
		success: true,
		stripePriceId: 'price_created',
		plans: [{ ...plan, stripePriceId: 'price_created' }],
	};
	assert.equal(
		contract.parseCreatedDraftPrice(payload, plan.id).stripePriceId,
		'price_created',
	);
	for (const invalid of [
		{ ...payload, stripePriceId: 'sk_secret' },
		{ ...payload, plans: [] },
		{
			...payload,
			plans: [{ ...plan, available: true, stripePriceId: 'price_created' }],
		},
		{ ...payload, plans: [{ ...plan, stripePriceId: 'price_different' }] },
		{ ...payload, plans: [payload.plans[0], payload.plans[0]] },
	])
		assert.throws(() => contract.parseCreatedDraftPrice(invalid, plan.id));
});
test('current Worker associated-plan response supports idempotent reuse without assuming a newly created or test-mode price', () => {
	const result = contract.parseCreatedDraftPrice(
		{
			success: true,
			plan: { ...plan, stripePriceId: 'price_existing' },
			reused: true,
		},
		plan.id,
	);
	assert.equal(result.stripePriceId, 'price_existing');
	assert.equal(result.reused, true);
	assert.throws(() =>
		contract.parseCreatedDraftPrice(
			{
				success: true,
				plan: { ...plan, available: true, stripePriceId: 'price_existing' },
				reused: true,
			},
			plan.id,
		),
	);
});
test('price creation POST sends only saved plan ID and never enables plan availability or checkout', async () => {
	const h = await harness([
		json({
			success: true,
			stripePriceId: 'price_created',
			plans: [{ ...plan, stripePriceId: 'price_created' }],
			settings,
		}),
	]);
	const result = await h.accountApi.createDraftPrice(plan.id);
	assert.equal(h.calls.length, 1);
	assert.equal(
		h.calls[0].url,
		'https://configured.example/admin/billing/price',
	);
	assert.equal(h.calls[0].init.method, 'POST');
	assert.deepEqual(JSON.parse(h.calls[0].init.body), { planId: plan.id });
	assert.equal(result.plans[0].available, false);
	assert.equal(result.settings.checkoutEnabled, false);
});
test('price creation is not automatically replayed after authentication rejection', async () => {
	const h = await harness([json({ success: false }, 401)]);
	await assert.rejects(
		h.accountApi.createDraftPrice(plan.id),
		/sign in again/i,
	);
	assert.equal(h.calls.length, 1);
	assert.equal(h.refreshes(), 0);
});
test('unconfigured Stripe price creation preserves the real safe server code and never invents a price', async () => {
	const h = await harness([
		json(
			{
				success: false,
				error: 'Server detail PRIVATE',
				code: 'billing_unconfigured',
			},
			503,
		),
	]);
	await assert.rejects(
		h.accountApi.createDraftPrice(plan.id),
		(error) =>
			error.code === 'billing_unconfigured' &&
			/not configured or live billing is disabled/i.test(error.message) &&
			!error.message.includes('PRIVATE'),
	);
	assert.equal(h.calls.length, 1);
});
test('authenticated GET refreshes once after 401 and validates response on retry', async () => {
	const h = await harness([
		json({ success: false }, 401),
		json({ success: true, account }),
	]);
	assert.equal((await h.accountApi.account()).id, account.id);
	assert.equal(h.refreshes(), 1);
	assert.equal(h.calls.length, 2);
	assert.equal(h.calls[0].url, 'https://configured.example/account');
	assert.equal(h.calls[0].init.headers.Authorization, 'Bearer synthetic-token');
	assert.equal(h.calls[0].init.redirect, 'error');
	assert.equal(h.calls[0].init.cache, 'no-store');
});
test('checkout POST is never replayed after 401 and contains only plan ID', async () => {
	const h = await harness([json({ success: false }, 401)]);
	await assert.rejects(h.accountApi.checkout('starter'), /sign in again/i);
	assert.equal(h.refreshes(), 0);
	assert.equal(h.calls.length, 1);
	assert.deepEqual(JSON.parse(h.calls[0].init.body), { planId: 'starter' });
});
test('native authenticated transport forbids redirects through plugin-http settings', async () => {
	const h = await harness([json({ success: true, account })], { native: true });
	await h.accountApi.account();
	assert.equal(h.calls[0].init.maxRedirections, 0);
	assert.equal(h.calls[0].init.connectTimeout, 10_000);
});
test('failed GET refresh preserves the actionable sign-in error without repeating the request', async () => {
	const h = await harness([json({ success: false }, 401)], {
		failedRefresh: true,
	});
	await assert.rejects(h.accountApi.account(), /sign in again/i);
	assert.equal(h.calls.length, 1);
	assert.equal(h.refreshes(), 1);
});
test('onboarding and feedback send only the frozen reviewed payload, never local history', async () => {
	const h = await harness([
		json({ success: true }),
		json({ success: true, reportId: 'report-test' }),
	]);
	await h.accountApi.completeOnboarding();
	assert.deepEqual(JSON.parse(h.calls[0].init.body), {
		version: 1,
		completed: true,
	});
	const feedback = {
		submissionId: '50ce2431-9945-420f-a05f-bd1bc52c9ef9',
		kind: 'idea',
		message: 'Reviewed idea',
		transcript: 'private',
		diagnostics: { platform: 'windows', appVersion: '7.0.0', token: 'private' },
	};
	assert.equal(await h.accountApi.feedback(feedback), 'report-test');
	assert.deepEqual(JSON.parse(h.calls[1].init.body), {
		submissionId: feedback.submissionId,
		kind: 'idea',
		message: 'Reviewed idea',
		diagnostics: { platform: 'windows', appVersion: '7.0.0' },
	});
});
test('API errors and invalid JSON never expose raw server bodies, tokens or URLs in errors/logs', async () => {
	for (const response of [
		json(
			{
				success: false,
				error: 'Bearer PRIVATE https://secret.example',
				code: 'stripe_not_configured',
			},
			503,
		),
		new Response('Bearer PRIVATE https://secret.example', { status: 500 }),
		json({ success: false, error: 'Bearer PRIVATE' }),
	]) {
		const h = await harness([response]);
		await assert.rejects(
			h.accountApi.account(),
			(error) => !/PRIVATE|secret\.example/.test(error.message),
		);
		assert.deepEqual(h.logs, []);
	}
	const h = await harness([json({ success: false }, 404)]);
	await assert.rejects(h.accountApi.account(), /not available on this server/i);
});
test('local test mode makes no account, checkout or feedback requests', async () => {
	const h = await harness([], { local: true });
	await assert.rejects(h.accountApi.account(), /disabled during local/i);
	await assert.rejects(
		h.accountApi.checkout('starter'),
		/disabled during local/i,
	);
	assert.equal(h.calls.length, 0);
});
test('changing identity or endpoint during a request discards stale account/admin responses', async () => {
	for (const change of ['identity', 'endpoint']) {
		let release;
		const h = await harness(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const pending = h.accountApi.account();
		await new Promise((resolve) => setImmediate(resolve));
		if (change === 'identity') h.user.set({ sub: 'different' });
		else h.config.value['voiceInput.endpoint'] = 'wss://other.example/realtime';
		release(json({ success: true, account }));
		await assert.rejects(pending, /sign in again/i);
	}
});
test('native opener receives only validated Stripe URL; arbitrary URLs never reach it', async () => {
	const h = await harness([]);
	await assert.rejects(
		h.openBillingUrl('https://evil.example/pay'),
		/unsafe billing link/i,
	);
	assert.equal(h.opened.length, 0);
	await h.openBillingUrl('https://billing.stripe.com/p/session/test');
	assert.deepEqual(h.opened, ['https://billing.stripe.com/p/session/test']);
});
