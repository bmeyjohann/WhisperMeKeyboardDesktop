<script lang="ts">
	import { getVersion } from '@tauri-apps/api/app';
	import { platform } from '@tauri-apps/plugin-os';
	import { accountApi } from '$lib/services/account-api';
	import { safeFeedback, type Feedback } from '$lib/services/account-contract';
	let { onclose }: { onclose: () => void } = $props();
	let kind = $state<'bug' | 'idea'>('bug');
	let message = $state('');
	let includeDiagnostics = $state(false);
	let reviewed = $state<Feedback | null>(null);
	let busy = $state(false);
	let error = $state('');
	let reportId = $state('');
	// Reuse the ID after an uncertain network result so the server can deduplicate.
	let submissionId = crypto.randomUUID();
	async function review() {
		busy = true;
		error = '';
		try {
			let diagnostics: Feedback['diagnostics'];
			if (includeDiagnostics) {
				if (window.__TAURI_INTERNALS__) {
					const os = platform();
					if (!['windows', 'macos', 'linux'].includes(os))
						throw new Error(
							'Technical details are unavailable. Uncheck them to continue.',
						);
					diagnostics = {
						platform: os as 'windows' | 'macos' | 'linux',
						appVersion: await getVersion(),
					};
				} else throw new Error('Technical details require the desktop app.');
			}
			reviewed = safeFeedback({
				submissionId,
				kind,
				message,
				...(diagnostics ? { diagnostics } : {}),
			});
		} catch {
			error =
				'Enter a message of 1–4,000 characters. If technical details are unavailable, uncheck them and retry.';
		} finally {
			busy = false;
		}
	}
	async function send() {
		if (!reviewed || busy) return;
		busy = true;
		error = '';
		try {
			reportId = await accountApi.feedback(reviewed);
		} catch (failure) {
			error =
				failure instanceof Error
					? failure.message
					: 'The report could not be sent. Retry with the same report.';
		} finally {
			busy = false;
		}
	}
	function edit() {
		reviewed = null;
		submissionId = crypto.randomUUID();
	}
</script>

<section
	class="space-y-4 rounded-xl border p-5"
	aria-labelledby="feedback-title"
>
	<h2 id="feedback-title" class="text-lg font-semibold">
		Report a bug or share an idea
	</h2>
	{#if reportId}
		<p role="status">Report sent. Reference: {reportId}</p>
		<button class="rounded border px-3 py-2" onclick={onclose}
			>Done — return to Account</button
		>
		<a class="ml-3 underline" href="/">Return to Transcripts</a>
	{:else if reviewed}
		<h3 class="font-medium">Review before sending</h3>
		<p>Type: {reviewed.kind === 'bug' ? 'Bug' : 'Idea'}</p>
		<p class="whitespace-pre-wrap break-words rounded bg-muted p-3">
			{reviewed.message}
		</p>
		{#if reviewed.diagnostics}
			<p>
				Technical details: {reviewed.diagnostics.platform} · app version {reviewed
					.diagnostics.appVersion}
			</p>
		{:else}<p>No technical details attached.</p>{/if}
		<p class="text-sm text-muted-foreground">
			Only this message and the technical details shown above will be sent with
			your account and a report reference. Remove any sensitive text before
			sending.
		</p>
		<div class="flex flex-wrap gap-3">
			<button class="rounded border px-3 py-2" disabled={busy} onclick={send}
				>{busy ? 'Sending…' : 'Send report'}</button
			>
			<button class="underline" disabled={busy} onclick={edit}>Edit</button>
			<button class="underline" disabled={busy} onclick={onclose}>Cancel</button
			>
		</div>
	{:else}
		<form
			class="space-y-4"
			onsubmit={(event) => {
				event.preventDefault();
				void review();
			}}
		>
			<label class="block"
				>Type <select
					class="ml-2 rounded border bg-background p-2"
					bind:value={kind}
					><option value="bug">Bug</option><option value="idea">Idea</option
					></select
				></label
			>
			<label class="block"
				>Message<textarea
					class="mt-1 block min-h-32 w-full rounded border bg-background p-3"
					maxlength="4000"
					required
					bind:value={message}
					placeholder="What happened, or what would you like to improve?"
				></textarea></label
			>
			<p class="text-sm text-muted-foreground">
				Transcripts, audio, screenshots, editor contents and credentials are not
				attached. Keep sensitive information out of your message.
			</p>
			<label class="flex gap-2"
				><input type="checkbox" bind:checked={includeDiagnostics} />Include app
				version and operating system only</label
			>
			<div class="flex gap-3">
				<button class="rounded border px-3 py-2" disabled={busy} type="submit"
					>{busy ? 'Preparing…' : 'Review report'}</button
				><button
					class="underline"
					type="button"
					disabled={busy}
					onclick={onclose}>Cancel</button
				>
			</div>
		</form>
	{/if}
	{#if error}<p role="alert">{error}</p>{/if}
</section>
