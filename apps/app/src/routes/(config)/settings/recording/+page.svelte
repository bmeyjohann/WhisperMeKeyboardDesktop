<script lang="ts">
	import { dev } from '$app/environment';
	import {
		LabeledInput,
		LabeledSelect,
	} from '$lib/components/labeled/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { settings } from '$lib/stores/settings.svelte';
	import {
		BITRATE_OPTIONS,
		RECORDING_MODE_OPTIONS,
		DEV_RECORDING_INPUT_MODE_OPTIONS,
	} from '$lib/constants/audio';
	import SelectRecordingDevice from './SelectRecordingDevice.svelte';
</script>

<svelte:head>
	<title>Recording Settings - WhisperMe</title>
</svelte:head>

<div class="space-y-6">
	<div>
		<h3 class="text-lg font-medium">Recording</h3>
		<p class="text-muted-foreground text-sm">
			Configure your WhisperMe recording preferences.
		</p>
	</div>
	<Separator />

	<LabeledSelect
		id="recording-mode"
		label="Recording Mode"
		items={RECORDING_MODE_OPTIONS}
		selected={settings.value['recording.mode']}
		onSelectedChange={(selected) => {
			settings.value = {
				...settings.value,
				'recording.mode': selected,
			};
		}}
		placeholder="Select a recording mode"
		description={`Choose how you want to activate recording: ${RECORDING_MODE_OPTIONS.map(
			(option) => option.label.toLowerCase(),
		).join(', ')}`}
	/>

	{#if dev}
		<div class="pl-4 border-l-2 border-muted space-y-4">
			<div>
				<h4 class="text-md font-medium">Dev Recording Input</h4>
				<p class="text-muted-foreground text-sm">
					Use this to test desktop flows without microphone access.
				</p>
			</div>

			<LabeledSelect
				id="dev-recording-input-mode"
				label="Dev Input Mode"
				items={DEV_RECORDING_INPUT_MODE_OPTIONS}
				selected={settings.value['dev.recording.inputMode']}
				onSelectedChange={(selected) => {
					settings.value = {
						...settings.value,
						'dev.recording.inputMode': selected,
					};
				}}
				description="`microphone` uses real capture, `disabled` bypasses mic and generates synthetic audio, `sample` loads a URL and falls back to synthetic audio."
			/>

			{#if settings.value['dev.recording.inputMode'] === 'sample'}
				<LabeledInput
					id="dev-sample-audio-url"
					label="Sample Audio URL"
					value={settings.value['dev.recording.sampleAudioUrl']}
					oninput={(event) => {
						const target = event.currentTarget as HTMLInputElement;
						settings.value = {
							...settings.value,
							'dev.recording.sampleAudioUrl': target.value,
						};
					}}
					placeholder="/dev-sample.wav"
					description="Local path or URL fetched at stop. Example: `/dev-sample.wav` or `https://.../sample.wav`."
				/>
			{/if}
		</div>
	{/if}

	{#if settings.value['recording.mode'] === 'manual' || settings.value['recording.mode'] === 'vad'}
		<div class="pl-4 border-l-2 border-muted space-y-6">
			<div>
				<h4 class="text-md font-medium">Navigator Settings</h4>
				<p class="text-muted-foreground text-sm">
					These settings apply to browser-based recording modes (Manual and
					Voice Activated).
				</p>
			</div>

			<SelectRecordingDevice
				deviceEnumerationStrategy="navigator"
				selected={settings.value['recording.navigator.selectedDeviceId'] ?? ''}
				onSelectedChange={(selected) => {
					settings.value = {
						...settings.value,
						'recording.navigator.selectedDeviceId': selected,
					};
				}}
			></SelectRecordingDevice>

			<LabeledSelect
				id="bit-rate"
				label="Bitrate"
				items={BITRATE_OPTIONS.map((option) => ({
					value: option.value,
					label: option.label,
				}))}
				selected={settings.value['recording.navigator.bitrateKbps'] ?? ''}
				onSelectedChange={(selected) => {
					settings.value = {
						...settings.value,
						'recording.navigator.bitrateKbps': selected,
					};
				}}
				placeholder="Select a bitrate"
				description="The bitrate of the recording. Higher values mean better quality but larger file sizes."
			/>
		</div>
	{:else if settings.value['recording.mode'] === 'cpal'}
		{#if window.__TAURI_INTERNALS__}
			<div class="pl-4 border-l-2 border-muted space-y-6">
				<div>
					<h4 class="text-md font-medium">CPAL Recording Settings</h4>
					<p class="text-muted-foreground text-sm">
						Native CPAL recording uses your system's audio APIs for better
						performance.
					</p>
				</div>

				<SelectRecordingDevice
					deviceEnumerationStrategy="cpal"
					selected={settings.value['recording.cpal.selectedDeviceId'] ?? ''}
					onSelectedChange={(selected) => {
						settings.value = {
							...settings.value,
							'recording.cpal.selectedDeviceId': selected,
						};
					}}
				></SelectRecordingDevice>
			</div>
		{:else}
			<div class="pl-4 border-l-2 border-muted space-y-6">
				<div>
					<h4 class="text-md font-medium">CPAL Recording Not Available</h4>
					<p class="text-muted-foreground text-sm">
						CPAL recording is only available in the desktop app.
					</p>
				</div>
			</div>
		{/if}
	{/if}
</div>
