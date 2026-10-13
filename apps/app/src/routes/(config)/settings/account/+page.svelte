<script lang="ts">
	import { onMount } from 'svelte';
	import { auth0Service, authUser } from '$lib/services/auth0';
	import { accountApi, openBillingUrl } from '$lib/services/account-api';
	import {
		formatMoney,
		type Account,
		type Plan,
	} from '$lib/services/account-contract';
	import BillingAdmin from '$lib/components/BillingAdmin.svelte';
	import FeedbackReport from '$lib/components/FeedbackReport.svelte';
	const localTest = auth0Service.localTest;
	let account = $state<Account | null>(null);
	let plans = $state<Plan[]>([]);
	let loading = $state(false);
	let busy = $state(false);
	let error = $state('');
	let planError = $state('');
	let notice = $state('');
	let showAdmin = $state(false);
	let showFeedback = $state(false);
	let reviewedOnboarding = $state(false);
	let generation = 0;
	let disposed = false;
	async function refresh() {
		if (loading || busy || $localTest) return;
		const current = ++generation;
		loading = true;
		error = '';
		planError = '';
		account = null;
		plans = [];
		showAdmin = false;
		const [accountResult, planResult] = await Promise.allSettled([
			accountApi.account(),
			accountApi.plans(),
		]);
		if (disposed || current !== generation) return;
		if (accountResult.status === 'fulfilled') account = accountResult.value;
		else
			error =
				accountResult.reason instanceof Error
					? accountResult.reason.message
					: 'Account details could not be loaded.';
		if (planResult.status === 'fulfilled') plans = planResult.value;
		else
			planError =
				planResult.reason instanceof Error
					? planResult.reason.message
					: 'Plans could not be loaded.';
		loading = false;
	}
	async function act(action: () => Promise<void>) {
		if (busy || loading) return;
		busy = true;
		error = '';
		notice = '';
		try {
			await action();
		} catch (failure) {
			error =
				failure instanceof Error
					? failure.message
					: 'This action could not be completed.';
		} finally {
			busy = false;
		}
	}
	async function completeOnboarding() {
		if (!reviewedOnboarding) return;
		await accountApi.completeOnboarding();
		account = await accountApi.account();
		notice = account.onboarding.completed
			? 'Setup saved to your account. You can return to Transcripts.'
			: 'Setup was submitted. Refresh your account to check its status.';
	}
	async function billing(planId?: string) {
		if (!account) return;
		const url = planId
			? await accountApi.checkout(planId)
			: await accountApi.portal();
		await openBillingUrl(url);
		notice =
			'Stripe opened in your browser. Complete or cancel there, then refresh Account to check your subscription. Access changes only after server confirmation.';
	}
	function date(value: string) {
		return new Date(value).toLocaleDateString();
	}
	function usagePercent(used: number, limit: number) {
		return limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
	}
	onMount(() => {
		void refresh();
		return () => {
			disposed = true;
			generation++;
		};
	});
</script>

<svelte:head><title>Account · WhisperMe</title></svelte:head>
<div class="space-y-6">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-2xl font-semibold">Account</h1>
			<p class="text-sm text-muted-foreground">Access, usage and billing</p>
		</div>
		<button
			class="rounded border px-3 py-2"
			disabled={loading || busy || $localTest}
			onclick={refresh}>{loading ? 'Refreshing…' : 'Refresh account'}</button
		>
	</div>
	{#if error}<p role="alert" class="rounded border p-4 break-words">
			{error}
		</p>{/if}
	{#if $localTest}
		<p role="status">
			Account services, checkout and feedback are disabled during local voice
			testing. Use your normal signed-in app to manage your account.
		</p>
	{:else}
		{#if loading}<p role="status">Loading your account…</p>{/if}
		{#if account}
			<section
				class="space-y-3 rounded-xl border p-5"
				aria-labelledby="access-title"
			>
				<h2 id="access-title" class="text-lg font-semibold">
					{$authUser?.email || $authUser?.name || 'Your account'}
				</h2>
				<p>
					Access: <strong>{account.access.state}</strong> · {account.access
						.allowed
						? 'Allowed by server'
						: 'Currently unavailable'}
				</p>
				{#if account.access.reason}<p>{account.access.reason}</p>{/if}
				{#if account.access.planId}<p>Plan: {account.access.planId}</p>{/if}
				{#if account.access.expiresAt}<p>
						Access expires {date(account.access.expiresAt)}
					</p>{/if}
				<p class="text-sm text-muted-foreground">
					{account.access.enforcementEnabled
						? 'Account access and usage limits are enforced by the server.'
						: 'Account access enforcement is currently disabled on the server.'}
				</p>
				<p>
					Subscription: {account.subscription.status} · {account.subscription
						.source === 'stripe'
						? 'Stripe'
						: account.subscription.source === 'test'
							? 'Test account'
							: 'No billing subscription'}
				</p>
				{#if account.subscription.canManage}<button
						class="rounded border px-3 py-2"
						disabled={busy || loading}
						onclick={() => act(() => billing())}
						>Manage subscription in Stripe</button
					>{/if}
			</section>
			{#if !account.onboarding.completed || account.onboarding.version < 1}
				<section
					class="space-y-3 rounded-xl border p-5"
					aria-labelledby="onboarding-title"
				>
					<h2 id="onboarding-title" class="text-lg font-semibold">
						Finish setup
					</h2>
					<ol class="list-decimal space-y-2 pl-5">
						<li>
							<a class="underline" href="/settings/transcription"
								>Review your microphone, shortcut and voice settings.</a
							> Keep your saved shortcuts or choose your own.
						</li>
						<li>
							Allow microphone access when Windows asks. Test dictation in an
							editable field and check the transcript before relying on it.
						</li>
						<li>
							Transcripts and session history stay on this device. Account usage
							tracks server activity across your signed-in devices; local
							history is not synced.
						</li>
						<li>
							Voice processing sends audio and required editing context to your
							configured service. Account setup does not enable additional
							diagnostic traces.
						</li>
					</ol>
					<label class="flex gap-2"
						><input type="checkbox" bind:checked={reviewedOnboarding} />I
						reviewed setup and understand where my history is stored.</label
					>
					<button
						class="rounded border px-3 py-2"
						disabled={!reviewedOnboarding || busy || loading}
						onclick={() => act(completeOnboarding)}>Complete setup</button
					>
				</section>
			{/if}
			<section
				class="space-y-4 rounded-xl border p-5"
				aria-labelledby="usage-title"
			>
				<h2 id="usage-title" class="text-lg font-semibold">Usage</h2>
				<p class="text-sm text-muted-foreground">
					{date(account.usage.periodStart)} – {date(account.usage.periodEnd)} · Server
					totals across your signed-in devices
				</p>
				<div>
					<label for="audio-usage"
						>Audio: {(account.usage.audioSeconds / 60).toFixed(1)} / {(
							account.usage.audioSecondsLimit / 60
						).toFixed(1)} minutes</label
					><progress
						id="audio-usage"
						class="mt-2 block w-full"
						max="100"
						value={usagePercent(
							account.usage.audioSeconds,
							account.usage.audioSecondsLimit,
						)}
					></progress>
				</div>
				<div>
					<label for="processing-usage"
						>Processing starts: {account.usage.processingStarts} / {account
							.usage.processingStartsLimit}</label
					><progress
						id="processing-usage"
						class="mt-2 block w-full"
						max="100"
						value={usagePercent(
							account.usage.processingStarts,
							account.usage.processingStartsLimit,
						)}
					></progress>
				</div>
				<p class="text-sm text-muted-foreground">
					The server determines access when a limit is zero or reached. Refresh
					to see recent activity.
				</p>
			</section>
			<section
				class="space-y-4 rounded-xl border p-5"
				aria-labelledby="plans-title"
			>
				<h2 id="plans-title" class="text-lg font-semibold">Monthly plans</h2>
				{#if !account.checkoutAvailable}<p>
						Checkout is not available for this account or server yet. No payment
						is required to finish setup.
					</p>{/if}
				{#if planError}<p role="alert">
						{planError}
					</p>{:else if plans.length === 0}<p>
						No plans are currently configured.
					</p>{/if}
				{#each plans as plan}
					<div class="space-y-2 rounded border p-4">
						<h3 class="font-medium">
							{plan.name} · {formatMoney(plan.amountCents, plan.currency)} / month
						</h3>
						<p>
							{(plan.audioSeconds / 60).toLocaleString()} audio minutes · {plan.processingStarts.toLocaleString()}
							processing starts / month
						</p>
						{#if !plan.available}<p class="text-sm">
								Currently unavailable
							</p>{/if}
						<button
							class="rounded border px-3 py-2"
							disabled={busy ||
								loading ||
								!account.checkoutAvailable ||
								!plan.available ||
								account.access.planId === plan.id}
							onclick={() => act(() => billing(plan.id))}
							>{account.access.planId === plan.id
								? 'Current plan'
								: `Continue with ${plan.name} in Stripe`}</button
						>
					</div>
				{/each}
				<p class="text-sm text-muted-foreground">
					Review the final amount and terms in Stripe before paying. Returning
					from checkout does not grant access by itself.
				</p>
			</section>
			<div class="flex flex-wrap gap-4">
				<button
					class="underline"
					disabled={busy}
					onclick={() => {
						showFeedback = !showFeedback;
					}}>Report a bug or idea</button
				>
				{#if account.canAdmin}<button
						class="underline"
						disabled={busy}
						aria-expanded={showAdmin}
						onclick={() => {
							showAdmin = !showAdmin;
						}}
						>{showAdmin
							? 'Hide owner billing settings'
							: 'Owner billing settings'}</button
					>{/if}
			</div>
			{#if showFeedback}<FeedbackReport
					onclose={() => {
						showFeedback = false;
					}}
				/>{/if}
			{#if account.canAdmin && showAdmin}<BillingAdmin />{/if}
		{:else if !loading}
			<section
				class="space-y-3 rounded-xl border p-5"
				aria-labelledby="account-unavailable-title"
			>
				<h2 id="account-unavailable-title" class="text-lg font-semibold">
					Account details unavailable
				</h2>
				<p>
					Your account access, subscription and usage could not be verified.
					Refresh your account to retry.
				</p>
				<p class="text-sm text-muted-foreground">
					If your session has expired, sign out below and sign in again. Your
					local transcripts remain on this device.
				</p>
			</section>
		{/if}
		<button
			class="underline"
			disabled={busy || loading}
			onclick={() => act(() => auth0Service.logout())}>Sign out</button
		>
	{/if}
	{#if notice}<p role="status">{notice}</p>{/if}
	<a class="inline-block underline" href="/">Return to Transcripts</a>
</div>

<style>
	button:disabled {
		opacity: 0.5;
	}
	progress {
		accent-color: var(--foreground);
	}
</style>
