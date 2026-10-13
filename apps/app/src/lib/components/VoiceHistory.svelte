<script lang="ts">
	import { voiceFeedback, voiceBudgetWarning } from '$lib/services/voice-feedback';
	import { onMount } from 'svelte';
	import { MicIcon } from 'lucide-svelte';
	import { commandCallbacks } from '$lib/commands';
	import { writeText } from '@tauri-apps/plugin-clipboard-manager';
	import { retryVoiceProcessing } from '$lib/services/realtime-voice';
	import {
		voiceHistory,
		voiceHistoryStorageError,
		initVoiceHistory,
		deleteVoiceHistory,
	} from '$lib/services/voice-history';
	let visible = $state(30);
	let message = $state('');
	const active = $derived(
		$voiceHistory.some((s) =>
			['connecting', 'recording', 'processing'].includes(s.status),
		),
	);
	onMount(() => {
		void initVoiceHistory();
	});
	async function copy(text: string) {
		try {
			if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) await writeText(text);
            else await navigator.clipboard.writeText(text);
			message = 'Copied';
		} catch {
			message = 'Could not copy. Expand the session to select its text.';
		}
	}
	const statusLabel = (status: string) => ({connecting: 'Connecting', recording: 'Recording', processing: 'Processing', interrupted: 'Interrupted', failed: 'Needs attention', insertion_failed: 'Ready to copy · field not verified', copy_ready: 'Ready to copy', processed: 'Processed', applied: 'Inserted', cancelled: 'Cancelled'}[status] || status.replaceAll('_', ' '));
	const time = (value: number) => new Date(value).toLocaleString();
</script>

<section class="history">
	<header>
		<div>
			<h1>Transcripts</h1>
			<p>Your recent dictation, ready to read and copy.</p>
		</div>
	</header>
	<nav>
		<button onclick={() => commandCallbacks.toggleManualRecording()}
			><MicIcon size={18} />{active ? 'Finish recording' : 'Record'}</button>
	</nav>
	<p class="notice">Saved on this device. Audio is not saved in this history.</p>
    {#if $voiceFeedback.connection}<p role="status">{$voiceFeedback.connection}</p>{/if}
    {#if $voiceBudgetWarning || $voiceFeedback.budget}<p role="status">{$voiceBudgetWarning || $voiceFeedback.budget}</p>{/if}
    {#if $voiceFeedback.retry}<p role="status">{$voiceFeedback.retry}</p>{/if}
	{#if $voiceHistoryStorageError}<p role="alert">
			{$voiceHistoryStorageError}
		</p>{/if}
	{#if message}<p role="status">{message}</p>{/if}
	{#if !$voiceHistory.length}<div class="empty">
			Your first transcript will appear here. Start recording, speak, then finish to insert your text.
		</div>{/if}
	{#each $voiceHistory.slice(0, visible) as session (session.id)}
		<article>
			<div class="session-heading">
				<time datetime={new Date(session.startedAt).toISOString()}
					>{time(session.startedAt)}</time
				><strong>{statusLabel(session.status)}</strong>
			</div>
			<p class="preview">
				{(
					session.result ||
					session.transcript ||
					'No transcript received yet'
				).slice(0, 220)}
			</p>
            {#if session.failure?.code === 'budget_exhausted'}<p role="alert">WhisperMe’s monthly server budget is exhausted. Your saved transcript remains available; retry after the server budget resets or is adjusted.</p>
            {:else if session.failure}<p role="status">{session.failure.stage === 'transcription' ? 'Transcription' : 'Text processing'} could not finish{session.failure.provider ? ` (${session.failure.provider})` : ''}. {session.failure.retryable ? 'You can retry when ready.' : 'Provider settings or the request need attention before retrying.'}</p>{/if}
            {#if session.budgetWarning || session.events.some(event => event.stage === 'budget.warning')}<p class="notice">{session.budgetWarning || session.events.findLast(event => event.stage === 'budget.warning')?.text}</p>{/if}
            <details>
                <summary>Speech transcript{session.finalTranscript === undefined ? ' · incomplete / not confirmed' : ''}</summary>
                <pre>{(session.finalTranscript ?? session.transcript) || 'Not received'}</pre>
            </details>
            {#if session.result}<details><summary>Final text</summary><pre>{session.result}</pre></details>{/if}
            {#if session.finalTranscript && session.recovery && !['applied', 'processed', 'copy_ready', 'cancelled'].includes(session.status)}
                <p class="notice">Recovery formats the complete transcript without the original editor context or saved instructions. Editing commands are not replayed. Review and copy the result yourself.</p>
                <button disabled={active} onclick={() => retryVoiceProcessing(session.id)}>Format complete transcript · copy only</button>
            {:else if !session.finalTranscript && ['failed', 'interrupted'].includes(session.status)}
                <p class="notice">Only an incomplete transcript is available. Copy it for review or record again; it cannot be retried as complete speech.</p>
            {/if}
            <details>
                <summary>Technical details and usage</summary>
                <p>{session.usage?.summary ?? 'Usage unavailable for this session; this does not mean it was free.'}</p>
                {#each session.usage?.calls ?? [] as call}<pre>{JSON.stringify(call, null, 2)}</pre>{/each}
                <dl>{#each Object.entries(session.metadata) as [key, value]}<div><dt>{({llmProvider: 'Text provider', llmModel: 'Text model', reasoningEffort: 'Reasoning effort', transcriptionProvider: 'Speech provider', transcriptionModel: 'Speech model', mode: 'Mode', transport: 'Connection'})[key] || key}</dt><dd>{key === 'reasoningEffort' ? value[0].toUpperCase() + value.slice(1) : value}</dd></div>{/each}</dl>
                {#if session.failure}<pre>{JSON.stringify(session.failure, null, 2)}</pre>{/if}
                <details><summary>Context and prompts</summary>
                    {#if session.diagnostics}<pre>{JSON.stringify(session.diagnostics, null, 2)}</pre>
                    {:else}<p>No context trace was saved. Enable “Save context and prompts” in advanced Voice settings before recording to capture future diagnostics.</p>{/if}
                </details>
                <h2>Timeline</h2>
                {#if session.omittedEvents}<p>{session.omittedEvents} older intermediate events omitted.</p>{/if}
                <ol>{#each session.events.filter(event => event.stage !== 'assistant.message' || event.text?.trim()) as event}<li>
                    <strong>+{((event.at - session.startedAt) / 1000).toFixed(1)}s · {event.stage}</strong>
                    {#if event.text !== undefined}<pre>{event.text}{event.truncated ? '\n[Event preview shortened]' : ''}</pre>{/if}
                </li>{/each}</ol>
                <button onclick={() => copy(JSON.stringify(session, null, 2))}>Copy technical details</button>
            </details>
			<footer>
				<button
					disabled={!session.transcript}
					onclick={() => copy(session.transcript)}>{session.finalTranscript === undefined ? 'Copy incomplete transcript' : 'Copy transcript'}</button
				><button disabled={!session.result} onclick={() => copy(session.result)}
					>Copy result</button
				>
				<button disabled={active} onclick={() => deleteVoiceHistory(session.id)}>Delete</button>
			</footer>
		</article>
	{/each}
	{#if $voiceHistory.length > visible}<button onclick={() => (visible += 30)}
			>Show older sessions</button
		>{/if}
</section>

<style>
	.history {
		width: 100%;
		max-width: 900px;
		margin: 0 auto;
		padding: 24px;
		box-sizing: border-box;
	}
	header,
	nav,
	footer,
	.session-heading {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	header,
	.session-heading {
		justify-content: space-between;
	}
	h1 {
		font-size: 28px;
		font-weight: 650;
		margin: 0;
	}
	h2 {
		font-size: 16px;
		font-weight: 600;
		margin-top: 20px;
	}
	p {
		line-height: 1.5;
	}
	header p,
	.notice {
		opacity: 0.7;
	}
	nav {
		margin: 20px 0;
	}
	button {display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:8px;padding:8px 12px;cursor:pointer;}
	nav button {background:var(--primary);color:var(--primary-foreground);}
	button:disabled {
		opacity: 0.4;
	}
	article {
		border: 1px solid #80808050;
		border-radius: 12px;
		padding: 18px;
		margin: 16px 0;
	}
	.session-heading {
		font-size: 13px;
	}
	.preview {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	details {
		margin: 16px 0;
	}
	summary {
		cursor: pointer;
	}
	pre {
		font: inherit;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		padding: 10px;
		border-radius: 6px;
		background: #80808015;
		max-height: 320px;
		overflow: auto;
	}
	dl div {
		display: flex;
		gap: 12px;
	}
	dt {
		min-width: 170px;
		opacity: 0.7;
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	ol {
		padding-left: 20px;
	}
	li {
		margin: 12px 0;
	}
	.empty {
		padding: 40px 0;
		opacity: 0.7;
	}
</style>
