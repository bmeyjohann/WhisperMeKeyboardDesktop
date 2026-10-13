import { get } from 'svelte/store';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { openUrl } from '@tauri-apps/plugin-opener';
import { auth0Service } from './auth0';
import { HttpClient } from './httpClient';
import { settings } from '$lib/stores/settings.svelte';
import {
	AccountServiceError,
	accountBaseUrl,
	parseAccount,
	parsePlans,
	parseAdminBilling,
	parseCreatedDraftPrice,
	successPayload,
	stripeUrl,
	billingDraftSchema,
	safeFeedback,
	type BillingDraft,
	type Feedback,
} from './account-contract';

export async function readAccountResponse(
	response: Response,
): Promise<unknown> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new AccountServiceError(response.ok ? 502 : response.status);
	}
	if (!response.ok) {
		const code =
			body &&
			typeof body === 'object' &&
			'code' in body &&
			typeof body.code === 'string' &&
			/^[a-z0-9_]{1,80}$/i.test(body.code)
				? body.code
				: undefined;
		throw new AccountServiceError(response.status, code);
	}
	return successPayload(body);
}
async function request(
	path: string,
	method: 'GET' | 'POST' | 'PUT',
	body?: unknown,
): Promise<unknown> {
	if (get(auth0Service.localTest))
		throw new Error(
			'Account services are disabled during local voice testing.',
		);
	const endpoint = settings.value['voiceInput.endpoint'];
	const identity = get(auth0Service.user)?.sub;
	if (!get(auth0Service.isAuthenticated) || !identity)
		throw new AccountServiceError(401);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		const client = new HttpClient(
			accountBaseUrl(endpoint),
			async (input, init) => {
				// Native HTTP avoids WebView CORS differences; browser previews use normal fetch.
				// plugin-http ignores Request.redirect; its own redirect limit must be explicit.
				return window.__TAURI_INTERNALS__
					? nativeFetch(input, {
							...init,
							maxRedirections: 0,
							connectTimeout: 10_000,
						})
					: fetch(input, init);
			},
			readAccountResponse,
		);
		const options = {
			requireAuth: true,
			retryOnAuth: method === 'GET',
			signal: controller.signal,
			redirect: 'error' as const,
			cache: 'no-store' as const,
		};
		const result =
			method === 'GET'
				? await client.get(path, options)
				: method === 'POST'
					? await client.post(path, body, options)
					: await client.put(path, body, options);
		if (
			settings.value['voiceInput.endpoint'] !== endpoint ||
			!get(auth0Service.isAuthenticated) ||
			get(auth0Service.user)?.sub !== identity
		)
			throw new AccountServiceError(401);
		return result;
	} catch (error) {
		if (error instanceof AccountServiceError) throw error;
		throw new AccountServiceError(0);
	} finally {
		clearTimeout(timer);
	}
}

export const accountApi = {
	async account() {
		return parseAccount(await request('/account', 'GET'));
	},
	async plans() {
		return parsePlans(await request('/plans', 'GET'));
	},
	async completeOnboarding() {
		successPayload(
			await request('/account/onboarding', 'POST', {
				version: 1,
				completed: true,
			}),
		);
	},
	async adminBilling() {
		return parseAdminBilling(await request('/admin/billing', 'GET'));
	},
	async saveBilling(draft: BillingDraft) {
		successPayload(
			await request('/admin/billing', 'PUT', billingDraftSchema.parse(draft)),
		);
	},
	async checkout(planId: string) {
		return stripeUrl(
			successPayload(await request('/billing/checkout', 'POST', { planId }))
				.url,
		);
	},
	async createDraftPrice(planId: string) {
		return parseCreatedDraftPrice(
			await request('/admin/billing/price', 'POST', { planId }),
			planId,
		);
	},
	async portal() {
		return stripeUrl(
			successPayload(await request('/billing/portal', 'POST', {})).url,
		);
	},
	async feedback(feedback: Feedback) {
		const result = successPayload(
			await request('/feedback', 'POST', safeFeedback(feedback)),
		);
		if (
			typeof result.reportId !== 'string' ||
			!/^[a-z0-9_-]{1,120}$/i.test(result.reportId)
		)
			throw new AccountServiceError(502);
		return result.reportId;
	},
};
export async function openBillingUrl(value: string): Promise<void> {
	const url = stripeUrl(value);
	try {
		await openUrl(url);
	} catch {
		throw new Error(
			'The Stripe page could not be opened. Return to Account and retry from the desktop app.',
		);
	}
}
