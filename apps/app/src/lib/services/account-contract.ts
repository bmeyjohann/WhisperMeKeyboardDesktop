import { z } from 'zod';

const count = z
	.number()
	.finite()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER);
const rate = z.number().finite().nonnegative();
const date = z
	.string()
	.refine((value) => Number.isFinite(Date.parse(value)), 'Invalid date');
const publicPlan = z.object({
	id: z.string().min(1).max(80),
	name: z.string().min(1).max(120),
	amountCents: count,
	currency: z.string().regex(/^[a-zA-Z]{3}$/),
	interval: z.literal('month'),
	audioSeconds: count,
	processingStarts: count,
	available: z.boolean(),
});
export const adminPlanSchema = publicPlan.extend({
	stripePriceId: z
		.string()
		.regex(/^price_[A-Za-z0-9]+$/)
		.optional(),
});
export const billingSettingsSchema = z.object({
	enforcementEnabled: z.boolean(),
	checkoutEnabled: z.boolean(),
	trialAudioSeconds: count,
	trialProcessingStarts: count,
	trialDays: count,
	asrUsdPerMinute: rate,
	llmInputUsdPerMillion: rate,
	llmOutputUsdPerMillion: rate,
	monthlyBudgetUsd: rate,
	warningRatio: z.number().finite().gt(0).lte(1),
});
export const billingDraftSchema = z.object({
	plans: z
		.array(adminPlanSchema)
		.max(50)
		.refine(
			(plans) => new Set(plans.map((p) => p.id)).size === plans.length,
			'Plan IDs must be unique',
		),
	settings: billingSettingsSchema,
});
const accountSchema = z.object({
	id: z.string().min(1),
	access: z.object({
		state: z.string(),
		allowed: z.boolean(),
		reason: z.string().optional(),
		planId: z.string().optional(),
		expiresAt: date.optional(),
		enforcementEnabled: z.boolean(),
	}),
	usage: z.object({
		periodStart: date,
		periodEnd: date,
		audioSeconds: rate,
		audioSecondsLimit: count,
		processingStarts: count,
		processingStartsLimit: count,
	}),
	subscription: z.object({
		source: z.enum(['stripe', 'none', 'test']),
		status: z.string(),
		canManage: z.boolean(),
	}),
	onboarding: z.object({ version: count, completed: z.boolean() }),
	canAdmin: z.boolean(),
	checkoutAvailable: z.boolean(),
});
export type Account = z.infer<typeof accountSchema>;
export type Plan = z.infer<typeof publicPlan>;
export type AdminPlan = z.infer<typeof adminPlanSchema>;
export type BillingSettings = z.infer<typeof billingSettingsSchema>;
export type BillingDraft = z.infer<typeof billingDraftSchema>;
const adminSchema = billingDraftSchema.and(
	z.object({
		costs: z.object({
			month: z.string(),
			knownUsd: rate.nullable(),
			unknownSessions: count,
			pendingReservations: count.default(0),
			sessionCount: count,
			audioSeconds: rate,
			processingStarts: count,
		}),
	}),
);
export type AdminBilling = z.infer<typeof adminSchema>;

export class AccountServiceError extends Error {
	constructor(
		public status: number,
		public code?: string,
	) {
		super(accountErrorMessage(status, code));
	}
}
export function accountErrorMessage(status: number, code?: string): string {
	if (status === 401 || code === 'authentication_required')
		return 'Your session has expired. Sign in again and retry.';
	if (status === 403)
		return 'Your account does not have permission for this action. Refresh your account to check access.';
	if (status === 404 || status === 501)
		return 'This account or billing feature is not available on this server yet.';
	if (code === 'billing_unconfigured')
		return 'Stripe billing is not configured or live billing is disabled on this server.';
	if (code === 'stripe_unavailable')
		return 'Stripe could not complete this operation. Check billing configuration or retry.';
	if (code === 'plan_must_be_draft')
		return 'Make this plan unavailable and save the draft before creating its Stripe price.';
	if (code === 'billing_config_changed')
		return 'The saved billing draft changed. Review the refreshed configuration before retrying.';
	if (code === 'price_association_mismatch')
		return 'Stripe could not verify that this price belongs to the saved draft. Owner review is required.';
	if (/not_configured|disabled|unavailable|price_mismatch/i.test(code ?? ''))
		return 'Billing is unavailable or not configured for this plan. No checkout was opened.';
	if (status === 429)
		return 'Too many requests. Wait a moment before retrying.';
	if (status === 400 || status === 422)
		return 'The server rejected these details. Review the values and try again.';
	return 'The account service could not complete this request. Check your connection and refresh before retrying.';
}
export function successPayload(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object') throw new AccountServiceError(502);
	const payload = value as Record<string, unknown>;
	if (payload.success !== true) {
		const code =
			typeof payload.code === 'string' &&
			/^[a-z0-9_]{1,80}$/i.test(payload.code)
				? payload.code
				: undefined;
		throw new AccountServiceError(0, code);
	}
	return payload;
}
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
	const result = schema.safeParse(value);
	if (!result.success) throw new AccountServiceError(502, 'invalid_response');
	return result.data;
}
export function parseAccount(value: unknown): Account {
	return parse(accountSchema, successPayload(value).account);
}
export function parsePlans(value: unknown): Plan[] {
	return parse(z.array(publicPlan).max(50), successPayload(value).plans);
}
export function parseAdminBilling(value: unknown): AdminBilling {
	return parse(adminSchema, successPayload(value));
}
export function parseCreatedDraftPrice(value: unknown, planId: string) {
	const payload = successPayload(value);
	// The current Worker also returns the associated plan with an idempotent reuse flag.
	if ('plan' in payload && !('plans' in payload)) {
		const associated = parse(
			z.object({ plan: adminPlanSchema, reused: z.boolean() }),
			payload,
		);
		if (
			associated.plan.id !== planId ||
			associated.plan.available ||
			!associated.plan.stripePriceId
		)
			throw new AccountServiceError(502, 'invalid_response');
		return {
			stripePriceId: associated.plan.stripePriceId,
			plans: [associated.plan],
			reused: associated.reused,
		};
	}
	const result = parse(
		z.object({
			stripePriceId: z.string().regex(/^price_[A-Za-z0-9]+$/),
			plans: z.array(adminPlanSchema).max(50),
			settings: billingSettingsSchema.optional(),
		}),
		payload,
	);
	const matching = result.plans.filter((plan) => plan.id === planId);
	if (
		matching.length !== 1 ||
		matching[0].available ||
		matching[0].stripePriceId !== result.stripePriceId
	)
		throw new AccountServiceError(502, 'invalid_response');
	return result;
}

export function parseMoneyCents(value: string): number {
	const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
	if (!match)
		throw new Error(
			'Enter a nonnegative price with at most two decimal places.',
		);
	const cents =
		Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
	if (!Number.isSafeInteger(cents)) throw new Error('The price is too large.');
	return cents;
}
export function formatMoney(cents: number, currency: string): string {
	try {
		return new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency,
		}).format(cents / 100);
	} catch {
		return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
	}
}
export function parseNonnegative(value: string, integer = false): number {
	if (!/^\d+(?:\.\d+)?$/.test(value.trim()))
		throw new Error('Enter a nonnegative number.');
	const number = Number(value);
	if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number)))
		throw new Error('Enter a valid number within the supported range.');
	return number;
}
export function stripeUrl(value: unknown): string {
	if (typeof value !== 'string' || value.trim() !== value)
		throw new Error('The server returned an unsafe billing link.');
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('The server returned an unsafe billing link.');
	}
	if (
		url.protocol !== 'https:' ||
		!['checkout.stripe.com', 'billing.stripe.com'].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.port ||
		/[\u0000-\u0020\\]/.test(value)
	) {
		throw new Error('The server returned an unsafe billing link.');
	}
	return url.href;
}
export function accountBaseUrl(endpoint: string): string {
	const url = new URL(endpoint);
	if (
		!['wss:', 'https:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error('Account services require a secure configured server.');
	}
	url.protocol = 'https:';
	return url.origin;
}
export const feedbackSchema = z.object({
	submissionId: z.string().uuid(),
	kind: z.enum(['bug', 'idea', 'support']),
	message: z.string().trim().min(1).max(4000),
	diagnostics: z
		.object({
			platform: z.enum(['windows', 'macos', 'linux', 'browser']),
			appVersion: z
				.string()
				.regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/)
				.max(40),
		})
		.optional(),
});
export type Feedback = z.infer<typeof feedbackSchema>;
export function safeFeedback(value: unknown): Feedback {
	return feedbackSchema.parse(value);
}
