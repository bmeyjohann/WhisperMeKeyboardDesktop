<script lang="ts">
	import { onMount } from 'svelte';
	import { accountApi } from '$lib/services/account-api';
	import {
		billingDraftSchema,
		AccountServiceError,
		parseMoneyCents,
		parseNonnegative,
		type AdminBilling,
		type BillingSettings,
		type AdminPlan,
	} from '$lib/services/account-contract';
	type PlanInput = Omit<
		AdminPlan,
		'amountCents' | 'audioSeconds' | 'processingStarts'
	> & { price: string; audioSeconds: string; processingStarts: string };
	type NumericSetting = Exclude<
		keyof BillingSettings,
		'checkoutEnabled' | 'enforcementEnabled'
	>;
	const fields: {
		key: NumericSetting;
		label: string;
		integer?: boolean;
		hint?: string;
	}[] = [
		{ key: 'trialAudioSeconds', label: 'Trial audio seconds', integer: true },
		{
			key: 'trialProcessingStarts',
			label: 'Trial processing starts',
			integer: true,
		},
		{ key: 'trialDays', label: 'Trial days', integer: true },
		{ key: 'asrUsdPerMinute', label: 'ASR USD / minute' },
		{ key: 'llmInputUsdPerMillion', label: 'LLM input USD / million tokens' },
		{ key: 'llmOutputUsdPerMillion', label: 'LLM output USD / million tokens' },
		{
			key: 'monthlyBudgetUsd',
			label: 'Cerebras monthly safety budget USD',
			hint: 'Current server safety budget for Cerebras only; not a hard cap across all providers.',
		},
		{
			key: 'warningRatio',
			label: 'Budget warning ratio',
			hint: 'Greater than 0, at most 1; 0.8 means 80%.',
		},
	];
	let loaded = $state<AdminBilling | null>(null);
	let plans = $state<PlanInput[]>([]);
	let values = $state<Partial<Record<NumericSetting, string>>>({});
	let checkoutEnabled = $state(false);
	let enforcementEnabled = $state(false);
	let acknowledgeEnabling = $state(false);
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	let savedSnapshot = $state('');
	const editorSnapshot = $derived(
		JSON.stringify({ plans, values, checkoutEnabled, enforcementEnabled }),
	);
	const dirty = $derived(editorSnapshot !== savedSnapshot);
	const enabling = $derived(
		!!loaded &&
			((checkoutEnabled && !loaded.settings.checkoutEnabled) ||
				(enforcementEnabled && !loaded.settings.enforcementEnabled)),
	);
	function populate(data: AdminBilling) {
		loaded = data;
		plans = data.plans.map(
			({ amountCents, audioSeconds, processingStarts, ...rest }) => ({
				...rest,
				price: (amountCents / 100).toFixed(2),
				audioSeconds: String(audioSeconds),
				processingStarts: String(processingStarts),
			}),
		);
		values = Object.fromEntries(
			fields.map(({ key }) => [key, String(data.settings[key])]),
		);
		checkoutEnabled = data.settings.checkoutEnabled;
		enforcementEnabled = data.settings.enforcementEnabled;
		acknowledgeEnabling = false;
		savedSnapshot = JSON.stringify({
			plans,
			values,
			checkoutEnabled,
			enforcementEnabled,
		});
	}
	async function load() {
		busy = true;
		error = '';
		try {
			populate(await accountApi.adminBilling());
		} catch (failure) {
			loaded = null;
			error =
				failure instanceof Error
					? failure.message
					: 'Owner billing settings could not be loaded.';
		} finally {
			busy = false;
		}
	}
	async function save() {
		if (!loaded || busy || (enabling && !acknowledgeEnabling)) return;
		busy = true;
		error = '';
		notice = '';
		try {
			const settings = {
				...loaded.settings,
				checkoutEnabled,
				enforcementEnabled,
			};
			for (const { key, integer } of fields)
				settings[key] = parseNonnegative(values[key] ?? '', integer);
			const draft = billingDraftSchema.safeParse({
				settings,
				plans: plans.map(
					({
						price,
						audioSeconds,
						processingStarts,
						stripePriceId,
						...rest
					}) => ({
						...rest,
						amountCents: parseMoneyCents(price),
						audioSeconds: parseNonnegative(audioSeconds, true),
						processingStarts: parseNonnegative(processingStarts, true),
						...(stripePriceId?.trim()
							? { stripePriceId: stripePriceId.trim() }
							: {}),
					}),
				),
			});
			if (!draft.success)
				throw new Error(
					draft.error.issues
						.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
						.join('; '),
				);
			await accountApi.saveBilling(draft.data);
			notice =
				'Configuration saved. No Stripe product or price was created. Refreshing saved settings…';
			populate(await accountApi.adminBilling());
			notice =
				'Configuration saved and read back from the server. You can explicitly create a Stripe price for a saved, unavailable draft below.';
		} catch (failure) {
			error =
				failure instanceof Error
					? failure.message
					: 'The configuration could not be saved.';
		} finally {
			busy = false;
		}
	}
	function canCreatePrice(plan: PlanInput) {
		return (
			!dirty &&
			!plan.available &&
			!!loaded?.plans.some((saved) => saved.id === plan.id && !saved.available)
		);
	}
	async function createPrice(plan: PlanInput) {
		if (busy || !canCreatePrice(plan)) return;
		busy = true;
		error = '';
		notice = '';
		try {
			const result = await accountApi.createDraftPrice(plan.id);
			notice = `Stripe price ${result.stripePriceId} is associated with the saved draft. Plan availability, checkout and existing customer prices were not changed by this action.`;
		} catch (failure) {
			error =
				failure instanceof Error
					? failure.message
					: 'Stripe price creation could not be confirmed.';
			if (failure instanceof AccountServiceError && failure.code)
				error += ` Server code: ${failure.code}.`;
		} finally {
			try {
				populate(await accountApi.adminBilling());
			} catch {
				loaded = null;
				error +=
					' Saved billing configuration could not be refreshed. Refresh owner settings before retrying price creation.';
			}
			busy = false;
		}
	}
	function addPlan() {
		plans = [
			...plans,
			{
				id: '',
				name: '',
				price: '0.00',
				currency: 'eur',
				interval: 'month',
				audioSeconds: '0',
				processingStarts: '0',
				available: false,
				stripePriceId: '',
			},
		];
	}
	onMount(() => {
		void load();
	});
</script>

<section
	class="space-y-5 rounded-xl border p-5"
	aria-labelledby="billing-admin-title"
>
	<h2 id="billing-admin-title" class="text-lg font-semibold">
		Owner billing settings
	</h2>
	<p class="text-sm text-muted-foreground">
		Edit draft plan prices, usage limits and expected cost rates. These rates
		are expectations, not verified invoice prices. Saving a draft does not
		approve or publish prices, or create Stripe objects. Stripe must verify the
		configured price before checkout. Never enter secret keys here.
	</p>
	{#if loaded}
		<div class="space-y-2 rounded bg-muted p-3">
			<h3 class="font-medium">
				Estimated costs across all providers · {loaded.costs.month}
			</h3>
			<p>
				{loaded.costs.knownUsd === null
					? 'Known cost unavailable'
					: `Known portion: $${loaded.costs.knownUsd.toFixed(4)} USD`} · {loaded
					.costs.sessionCount} sessions · {loaded.costs.unknownSessions} with unknown
				costs
			</p>
			<p class="text-sm">
				{(loaded.costs.audioSeconds / 60).toFixed(1)} audio minutes · {loaded
					.costs.processingStarts} processing starts
			</p>
			<p>Pending reservations: {loaded.costs.pendingReservations}</p>
			<p class="text-sm text-muted-foreground">
				Pending reservations are work in progress. Final usage and estimated
				costs may change as that work completes.
			</p>
			{#if loaded.costs.unknownSessions > 0 || loaded.costs.knownUsd === null}<p
				>
					Cost data is incomplete. Unknown costs are excluded from the known
					portion.
				</p>{/if}
			<p class="text-sm text-muted-foreground">
				Expected USD estimates, not provider invoices. The Cerebras safety
				budget applies to Cerebras only; these totals cover all providers and
				cannot verify Cerebras budget status. A budget of 0 has server-defined
				behavior.
			</p>
		</div>
		<form
			class="space-y-5"
			onsubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<fieldset disabled={busy} class="space-y-5">
				<legend class="mb-2 font-medium">Monthly plans</legend>
				{#each plans as plan, index}
					<div class="space-y-3 rounded border p-3">
						<h3 class="font-medium">Plan {index + 1}</h3>
						<div class="grid gap-3 sm:grid-cols-2">
							<label
								>Plan ID<input
									class="field"
									required
									maxlength="80"
									bind:value={plan.id}
								/></label
							>
							<label
								>Name<input
									class="field"
									required
									maxlength="120"
									bind:value={plan.name}
								/></label
							>
							<label
								>Monthly price<input
									class="field"
									required
									inputmode="decimal"
									bind:value={plan.price}
								/></label
							>
							<label
								>Currency (3 letters)<input
									class="field"
									required
									pattern="[a-zA-Z]{3}"
									maxlength="3"
									bind:value={plan.currency}
								/></label
							>
							<label
								>Audio seconds / month<input
									class="field"
									required
									inputmode="numeric"
									bind:value={plan.audioSeconds}
								/></label
							>
							<label
								>Processing starts / month<input
									class="field"
									required
									inputmode="numeric"
									bind:value={plan.processingStarts}
								/></label
							>
						</div>
						<details>
							<summary class="cursor-pointer text-sm"
								>Advanced · Stripe Price ID</summary
							>
							<label class="mt-2 block"
								>Stripe Price ID (optional)<input
									class="field"
									placeholder="price_…"
									bind:value={plan.stripePriceId}
									autocomplete="off"
								/></label
							>
						</details>
						<label class="flex gap-2"
							><input type="checkbox" bind:checked={plan.available} />Plan
							available when checkout is enabled</label
						>
						<button
							type="button"
							class="rounded border px-3 py-2"
							disabled={!canCreatePrice(plan)}
							onclick={() => createPrice(plan)}
							>Create Stripe price for this saved draft</button
						>
						<p class="text-sm text-muted-foreground">
							Save all edits first with this plan unavailable. This explicitly
							creates a price in the server-configured Stripe mode; it does not
							publish the plan, enable checkout or change existing customer
							prices.
						</p>
						<button
							type="button"
							class="text-sm underline"
							onclick={() => {
								plans = plans.filter((_, i) => i !== index);
							}}>Remove this draft plan</button
						>
					</div>
				{/each}
				<button
					class="rounded border px-3 py-2"
					type="button"
					onclick={addPlan}
					disabled={plans.length >= 50}>Add draft plan</button
				>
				<h3 class="font-medium">Trial, cost rates and budget</h3>
				<div class="grid gap-3 sm:grid-cols-2">
					{#each fields as field}<label
							>{field.label}<input
								class="field"
								required
								inputmode={field.integer ? 'numeric' : 'decimal'}
								bind:value={values[field.key]}
							/>{#if field.hint}<span class="text-sm text-muted-foreground"
									>{field.hint}</span
								>{/if}</label
						>{/each}
				</div>
				<label class="flex gap-2"
					><input
						type="checkbox"
						bind:checked={checkoutEnabled}
						onchange={() => {
							acknowledgeEnabling = false;
						}}
					/>Enable checkout (requires server Stripe configuration)</label
				>
				<label class="flex gap-2"
					><input
						type="checkbox"
						bind:checked={enforcementEnabled}
						onchange={() => {
							acknowledgeEnabling = false;
						}}
					/>Enforce account access and usage limits</label
				>
				{#if enabling}<label class="flex gap-2 rounded border p-3"
						><input type="checkbox" bind:checked={acknowledgeEnabling} />I
						reviewed enabling checkout or access enforcement. The server decides
						whether this configuration can take effect.</label
					>{/if}
				<button
					type="submit"
					class="rounded border px-3 py-2"
					disabled={enabling && !acknowledgeEnabling}
					>{busy ? 'Saving…' : 'Save draft configuration'}</button
				>
			</fieldset>
		</form>
	{:else if busy}<p role="status">Loading owner settings…</p>
	{:else}<button class="rounded border px-3 py-2" onclick={load}
			>Retry owner settings</button
		>{/if}
	{#if notice}<p role="status">{notice}</p>{/if}
	{#if error}<p role="alert" class="break-words">{error}</p>{/if}
</section>

<style>
	.field {
		display: block;
		width: 100%;
		margin-top: 4px;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--background);
	}
	button:disabled {
		opacity: 0.5;
	}
</style>
