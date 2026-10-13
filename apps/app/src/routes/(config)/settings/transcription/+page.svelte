<script lang="ts">
	import ShortcutTable from '../shortcuts/keyboard-shortcut-recorder/ShortcutTable.svelte';
	import SelectRecordingDevice from '../recording/SelectRecordingDevice.svelte';
	import VoicePreferences from '$lib/components/VoicePreferences.svelte';
	import {
		LabeledSelect,
		LabeledSwitch,
	} from '$lib/components/labeled/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { settings } from '$lib/stores/settings.svelte';
	import {
		TRANSCRIPTION_SERVICE_OPTIONS,
		VOICE_INPUT_LLM_PROVIDER_OPTIONS,
		VOICE_INPUT_TRANSCRIPTION_PROVIDER_OPTIONS,
	} from '$lib/constants/transcription';
	import { CheckIcon, AlertCircleIcon } from 'lucide-svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { auth0Service, authUser } from '$lib/services/auth0';
	import {
		VOICE_LLM_MODELS,
		compatibleLlmModel, reasoningChoices, type ReasoningEffort,
	} from '$lib/constants/transcription/backend-provider-config';

	$effect(() => {
		if (settings.value['voiceInput.llmRouting'] !== 'explicit') return;
		const provider = settings.value['voiceInput.llmProvider'];
		const model = compatibleLlmModel(
			provider,
			settings.value['voiceInput.llmModel'],
		);
		if (model !== settings.value['voiceInput.llmModel'])
			settings.value = { ...settings.value, 'voiceInput.llmModel': model };
	});

	let serverModel = $state<string | undefined>();
    let serverEndpoint = $state('');
    let advertisedReasoning = $state<ReasoningEffort[] | undefined>();
    const reasoningModel = $derived(settings.value['voiceInput.llmRouting'] === 'explicit' ? compatibleLlmModel(settings.value['voiceInput.llmProvider'], settings.value['voiceInput.llmModel']) : serverEndpoint === settings.value['voiceInput.endpoint'] ? serverModel : undefined);
    const allowedReasoning = $derived(settings.value['voiceInput.llmRouting'] === 'server' && serverEndpoint === settings.value['voiceInput.endpoint'] && advertisedReasoning?.length ? advertisedReasoning : reasoningChoices(reasoningModel));
    $effect(() => {
        if (!allowedReasoning.includes(settings.value['voiceInput.reasoningEffort'])) settings.value = {...settings.value, 'voiceInput.reasoningEffort': 'default'};
    });
    let showAdvanced = $state(false);
	let backendStatus = $state<'testing' | 'connected' | 'error' | 'unknown'>(
		'unknown',
	);
	let statusMessage = $state('');
	let isTestingOverlay = $state(false);

	const testBackendConnection = async () => {
		backendStatus = 'testing';
		statusMessage = 'Testing connection...';

		try {
			const token = await auth0Service.getVoiceAccessToken();
			if (!token) {
				backendStatus = 'unknown';
				statusMessage =
					'Sign in to test your server and provider configuration.';
				return;
			}
			const result = await invoke<{
				protocolVersion: number;
                defaults?: {llmProvider: string; llmModel: string; reasoningEfforts?: ReasoningEffort[]};
				transcription: { provider: string; configured: boolean }[];
				llm: { provider: string; configured: boolean; reasoning?: Record<string, ReasoningEffort[]> }[];
			}>('voice_backend_status', {
				endpoint: settings.value['voiceInput.endpoint'],
				token,
			});
			if (result.protocolVersion !== 2)
				throw new Error('Deploy the updated voice backend first');
			serverModel = result.defaults?.llmModel;
            serverEndpoint = settings.value['voiceInput.endpoint'];
            advertisedReasoning = result.defaults ? result.llm.find(item => item.provider === result.defaults?.llmProvider)?.reasoning?.[result.defaults.llmModel] : undefined;
            backendStatus = 'connected';
			statusMessage = (result.defaults ? `Server default: ${result.defaults.llmProvider} / ${result.defaults.llmModel} · ` : '') + [...result.transcription, ...result.llm]
				.map(
					(item) =>
						`${item.provider}: ${item.configured ? 'configured' : 'missing key'}`,
				)
				.join(' · ');
		} catch (error) {
			backendStatus = 'error';
			statusMessage =
				error instanceof Error
					? error.message
					: typeof error === 'string'
						? error
						: 'Connection failed';
		}
	};


	const testOverlayWindow = async () => {
		if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return;
		isTestingOverlay = true;
		try {
			await invoke('show_recording_overlay');
			await new Promise((resolve) => setTimeout(resolve, 1200));
			await invoke('show_processing_overlay');
			await new Promise((resolve) => setTimeout(resolve, 800));
		} finally {
			await invoke('hide_recording_overlay').catch(() => undefined);
			isTestingOverlay = false;
		}
	};
</script>

<svelte:head>
	<title>Voice settings · WhisperMe</title>
</svelte:head>

<div class="space-y-6">
	<div>
		<h1 class="text-2xl font-semibold">Voice settings</h1>
		<p class="text-muted-foreground text-sm">
			Sign in, use your recording shortcut, and start speaking. Defaults are ready to use.
		</p>
	</div>
	<Separator />

{#if $authUser}<section class="rounded-xl border p-5 space-y-3">
 <h3 class="font-medium">Account</h3>
 <p class="text-sm text-muted-foreground">{$authUser?.name || $authUser?.email || 'Sign in to start dictating.'}</p>
 {#if $authUser}<Button variant="outline" size="sm" onclick={() => auth0Service.logout()}>Sign out</Button>{/if}
</section>{/if}
<section class="rounded-xl border p-5 space-y-3">
 <h3 class="font-medium">Recording</h3>
 <p class="text-sm">Open a text field and press <strong>{settings.value['shortcuts.global.toggleManualRecording'] || 'your recording shortcut'}</strong>. Tap again to finish, or hold the shortcut for at least one second and release to finish. You can also click the captions.</p>
 {#if window.__TAURI_INTERNALS__}<details><summary class="cursor-pointer text-sm">Change shortcut</summary><div class="pt-3"><ShortcutTable type="global" basic /></div></details>{/if}
 <details><summary class="cursor-pointer text-sm">Choose microphone</summary>
 <div class="pt-3"><SelectRecordingDevice deviceEnumerationStrategy="navigator" selected={settings.value['recording.navigator.selectedDeviceId'] ?? ''} onSelectedChange={(selected) => settings.value = {...settings.value, 'recording.navigator.selectedDeviceId': selected || null}} /></div>
 </details>
</section>
<VoicePreferences />
<section class="rounded-xl border p-5">
 <button class="cursor-pointer font-medium" aria-expanded={showAdvanced} aria-controls="advanced-voice-settings" onclick={() => showAdvanced = !showAdvanced}>{showAdvanced ? 'Hide advanced settings' : 'Advanced settings'}</button>
 {#if showAdvanced}<div id="advanced-voice-settings" class="space-y-6 pt-5">
 <p class="text-sm text-muted-foreground">Optional service, model and troubleshooting controls. The defaults work without changes.</p>
	<LabeledSelect
		id="transcription-service"
		label="Transcription Service"
		items={TRANSCRIPTION_SERVICE_OPTIONS}
		selected={settings.value['transcription.selectedTranscriptionService']}
		onSelectedChange={(selected) => {
			settings.value = {
				...settings.value,
				'transcription.selectedTranscriptionService': selected,
			};
		}}
		description="Choose whether transcription runs directly against provider APIs or through WhisperMe authenticated backend."
	/>

	<!-- Backend Connection Status -->
	<Card.Root>
		<Card.Header>
			<Card.Title class="text-lg">Backend Connection</Card.Title>
			<Card.Description>
				Voice processing is handled by our custom backend service.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			<div class="flex items-center gap-2">
				{#if backendStatus === 'testing'}
					<Badge variant="outline">Testing...</Badge>
				{:else if backendStatus === 'connected'}
					<Badge variant="default" class="bg-green-100 text-green-800">
						<CheckIcon class="w-3 h-3 mr-1" />
						Connected
					</Badge>
				{:else if backendStatus === 'error'}
					<Badge variant="destructive">
						<AlertCircleIcon class="w-3 h-3 mr-1" />
						Error
					</Badge>
				{:else}
					<Badge variant="secondary">Unknown</Badge>
				{/if}
				<span class="text-sm text-muted-foreground">{statusMessage}</span>
			</div>
			<Button
				variant="outline"
				size="sm"
				onclick={testBackendConnection}
				disabled={backendStatus === 'testing'}
			>
				Test Connection
			</Button>
		</Card.Content>
	</Card.Root>

	{#if settings.value['transcription.selectedTranscriptionService'] === 'WhisperMe'}
		<Card.Root>
			<Card.Header>
				<Card.Title class="text-lg">WhisperMe Providers</Card.Title>
				<Card.Description>
					Choose the services used to transcribe and edit your text.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<LabeledSelect
					id="voiceinput-transcription-provider"
					label="Transcription Provider"
					items={VOICE_INPUT_TRANSCRIPTION_PROVIDER_OPTIONS}
					selected={settings.value['voiceInput.transcriptionProvider']}
					onSelectedChange={(selected) => {
						settings.value = {
							...settings.value,
							'voiceInput.transcriptionProvider': selected,
						};
					}}
					description="Muse streams live captions. Batch providers upload the recording after you finish."
				/>
                <LabeledSelect id="voiceinput-llm-routing" label="Text processing"
                    items={[{value: 'server', label: 'WhisperMe default (recommended)'}, {value: 'explicit', label: 'Choose provider and model'}]}
                    selected={settings.value['voiceInput.llmRouting']}
                    onSelectedChange={(value) => settings.value = {...settings.value, 'voiceInput.llmRouting': value as 'server' | 'explicit'}}
                    description="WhisperMe selects the current server default. Your saved overrides remain available." />
                {#if settings.value['voiceInput.llmRouting'] === 'explicit'}
				<LabeledSelect
					id="voiceinput-llm-provider"
					label="LLM Provider"
					items={VOICE_INPUT_LLM_PROVIDER_OPTIONS}
					selected={settings.value['voiceInput.llmProvider']}
					onSelectedChange={(selected) => {
						settings.value = {
							...settings.value,
							'voiceInput.llmProvider': selected,
							'voiceInput.llmModel': compatibleLlmModel(
								selected,
								settings.value['voiceInput.llmModel'],
							),
						};
					}}
					description="Used by WhisperMe backend for final text generation."
				/>
				<LabeledSelect
					id="voiceinput-llm-model"
					label="LLM model"
					items={VOICE_LLM_MODELS[settings.value['voiceInput.llmProvider']]}
					selected={compatibleLlmModel(
						settings.value['voiceInput.llmProvider'],
						settings.value['voiceInput.llmModel'],
					)}
					onSelectedChange={(model) =>
						(settings.value = {
							...settings.value,
							'voiceInput.llmModel': model,
						})}
					description="Models supported by the selected provider. Provider billing and access must also be active."
				/>
                {/if}
                <fieldset class="space-y-2">
                    <legend class="text-sm font-medium">Reasoning effort</legend>
                    <label for="reasoning-effort-slider" class="text-sm">Selected: <strong>{settings.value['voiceInput.reasoningEffort'][0].toUpperCase() + settings.value['voiceInput.reasoningEffort'].slice(1)}</strong></label>
                    <input id="reasoning-effort-slider" type="range" class="w-full accent-primary" min="0" max={allowedReasoning.length - 1} step="1"
                        aria-label="Reasoning effort" aria-valuetext={settings.value['voiceInput.reasoningEffort']}
                        aria-describedby="reasoning-effort-help"
                        value={Math.max(0, allowedReasoning.indexOf(settings.value['voiceInput.reasoningEffort']))}
                        oninput={(event) => { const effort = allowedReasoning[Number(event.currentTarget.value)]; if (effort) settings.value = {...settings.value, 'voiceInput.reasoningEffort': effort}; }} />
                    <div class="flex justify-between text-xs text-muted-foreground" aria-hidden="true">
                        {#each allowedReasoning as effort}<span>{effort[0].toUpperCase() + effort.slice(1)}</span>{/each}
                    </div>
                    {#if !allowedReasoning.includes('none')}<p class="text-sm text-muted-foreground">None is unavailable for this model.</p>{/if}
                    <p id="reasoning-effort-help" class="text-sm text-muted-foreground">Default follows the server and provider. Higher effort may take longer. Use the arrow keys to move between supported levels.</p>
                    {#if settings.value['voiceInput.llmRouting'] === 'server' && !reasoningModel}<p class="text-sm text-muted-foreground">Test Connection to check the current default model. Until then, the server validates your selected level.</p>{/if}
                </fieldset>
                <label class="block"
					>Transcription model (empty uses provider default)
					<input
						class="mt-1 w-full rounded border bg-background p-2"
						value={settings.value['voiceInput.transcriptionModel']}
						oninput={(event) =>
							(settings.value = {
								...settings.value,
								'voiceInput.transcriptionModel': event.currentTarget.value,
							})}
					/>
				</label>
				<label class="block"
					>WhisperMe realtime endpoint
					<input
						class="mt-1 w-full rounded border bg-background p-2"
						type="url"
						value={settings.value['voiceInput.endpoint']}
						oninput={(event) =>
							(settings.value = {
								...settings.value,
								'voiceInput.endpoint': event.currentTarget.value,
							})}
					/>
				</label>
				<p class="text-sm text-muted-foreground">
					Use your trusted WhisperMe server. This endpoint receives your sign-in
					token and audio. Provider API keys stay on that server.
				</p>
				<LabeledSelect
					id="voice-mode"
					label="Voice mode"
					items={[
						{ value: 'auto', label: 'Automatic' },
						{ value: 'verbatim', label: 'Verbatim' },
						{ value: 'clean', label: 'Clean dictation' },
						{ value: 'command', label: 'Editing command' },
					]}
					selected={settings.value['voiceInput.mode']}
					onSelectedChange={(value) =>
						(settings.value = {
							...settings.value,
							'voiceInput.mode': value as
								| 'auto'
								| 'verbatim'
								| 'clean'
								| 'command',
						})}
				/>
				<LabeledSwitch
					id="voice-live-hints"
					label="Live clarification questions (experimental)"
					checked={settings.value['voiceInput.liveHints']}
					onCheckedChange={(value) =>
						(settings.value = {
							...settings.value,
							'voiceInput.liveHints': value,
						})}
					description="Show optional assistant questions in blue while you speak. Adds LLM requests."
				/>
			</Card.Content>
		</Card.Root>
	{/if}

	<!-- Overlay Settings -->
	<Card.Root>
		<Card.Header>
			<Card.Title class="text-lg">Recording Overlay</Card.Title>
			<Card.Description>
				Configure the floating overlay that appears during recording.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<LabeledSwitch
				id="overlay-enabled"
				label="Show recording overlay"
				checked={settings.value['overlay.enabled']}
				onCheckedChange={(v) => {
					settings.value = {
						...settings.value,
						'overlay.enabled': v,
					};
				}}
			/>
			<div class="text-sm text-muted-foreground mt-3">
				<p>• Position: Bottom center of screen</p>
				<p>• Click overlay to stop recording</p>
				<p>• Automatically hides when processing completes</p>
			</div>
			{#if window.__TAURI_INTERNALS__}
				<Button
					variant="outline"
					size="sm"
					class="mt-3"
					onclick={testOverlayWindow}
					disabled={isTestingOverlay}
				>
					{isTestingOverlay ? 'Testing overlay...' : 'Test overlay window'}
				</Button>
			{/if}
		</Card.Content>
	</Card.Root>

	<label><input type="checkbox" checked={settings.value['voiceInput.diagnosticContext']} onchange={e => settings.value = {...settings.value, 'voiceInput.diagnosticContext': e.currentTarget.checked}} /> Save context and prompts with transcripts</label>
	<p>Includes text supplied from the editor and related fields, model prompts and tool results in local session history. May contain private text. No audio or credentials. Delete a session to remove its trace.</p>

<nav aria-label="Additional settings" class="flex flex-wrap gap-4 text-sm underline">
 <a href="/settings/general">App behavior</a><a href="/settings/recording">Recording configuration</a><a href="/settings/api-keys">API keys</a><a href="/settings/sound">Sounds</a><a href="/settings/shortcuts/local">In-app shortcuts</a><a href="/settings/shortcuts/global">All global shortcuts</a>
 <a href="/recordings">Older recordings</a><a href="/transformations">Legacy transformations</a>
</nav>
</div>{/if}</section>
</div>
