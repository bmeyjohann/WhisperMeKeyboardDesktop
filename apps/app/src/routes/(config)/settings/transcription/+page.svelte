<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { Badge } from '$lib/components/ui/badge/index.js';
	import { settings } from '$lib/stores/settings.svelte';
	import { CheckIcon, AlertCircleIcon } from 'lucide-svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';

	let backendStatus: 'testing' | 'connected' | 'error' | 'unknown' = 'unknown';
	let statusMessage = '';

	const testBackendConnection = async () => {
		backendStatus = 'testing';
		statusMessage = 'Testing connection...';
		
		try {
			const result = await invoke('test_backend_connection');
			if (result) {
				backendStatus = 'connected';
				statusMessage = 'Backend connection successful';
			} else {
				backendStatus = 'error';
				statusMessage = 'Backend is not reachable';
			}
		} catch (error) {
			backendStatus = 'error';
			statusMessage = error instanceof Error ? error.message : 'Connection failed';
		}
	};

	onMount(() => {
		// Test connection on page load
		testBackendConnection();
	});
</script>

<svelte:head>
	<title>Voice Processing Settings - Whispering</title>
</svelte:head>

<div class="space-y-6">
	<div>
		<h3 class="text-lg font-medium">Voice Processing</h3>
		<p class="text-muted-foreground text-sm">
			Configure your voice input and processing preferences.
		</p>
	</div>
	<Separator />

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
				on:click={testBackendConnection}
				disabled={backendStatus === 'testing'}
			>
				Test Connection
			</Button>
		</Card.Content>
	</Card.Root>

	<!-- Recording Device Selection -->
	<Card.Root>
		<Card.Header>
			<Card.Title class="text-lg">Recording Device</Card.Title>
			<Card.Description>
				The microphone device will be automatically selected. You can change it in the recording settings.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<div class="text-sm text-muted-foreground">
				<p>• Microphone device: Auto-detect</p>
				<p>• Audio format: 16kHz, Mono, WAV</p>
				<p>• Recording quality: Optimized for voice</p>
			</div>
		</Card.Content>
	</Card.Root>

	<!-- Overlay Settings -->
	<Card.Root>
		<Card.Header>
			<Card.Title class="text-lg">Recording Overlay</Card.Title>
			<Card.Description>
				Configure the floating overlay that appears during recording.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<div class="space-y-4">
				<div class="flex items-center justify-between">
					<div>
						<p class="font-medium">Show Recording Overlay</p>
						<p class="text-sm text-muted-foreground">
							Display a floating indicator when recording is active
						</p>
					</div>
					<label class="inline-flex items-center">
						<input
							type="checkbox"
							class="sr-only"
							checked={settings.value['overlay.enabled'] ?? true}
							on:change={(e) => {
								settings.value = {
									...settings.value,
									'overlay.enabled': e.target.checked,
								};
							}}
						/>
						<div class="relative">
							<div class="w-10 h-6 bg-gray-200 rounded-full shadow-inner"></div>
							<div class="absolute inset-y-0 left-0 w-6 h-6 bg-white rounded-full shadow transform transition-transform duration-200 ease-in-out {settings.value['overlay.enabled'] ?? true ? 'translate-x-4' : 'translate-x-0'}"></div>
						</div>
					</label>
				</div>
				<div class="text-sm text-muted-foreground">
					<p>• Position: Bottom center of screen</p>
					<p>• Click overlay to stop recording</p>
					<p>• Automatically hides when processing completes</p>
				</div>
			</div>
		</Card.Content>
	</Card.Root>

	<!-- Processing Information -->
	<Card.Root>
		<Card.Header>
			<Card.Title class="text-lg">AI Processing</Card.Title>
			<Card.Description>
				Your voice is processed using advanced AI models for transcription and intelligent text generation.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<div class="space-y-3">
				<div class="flex items-center gap-2">
					<CheckIcon class="w-4 h-4 text-green-600" />
					<span class="text-sm">Context-aware processing</span>
				</div>
				<div class="flex items-center gap-2">
					<CheckIcon class="w-4 h-4 text-green-600" />
					<span class="text-sm">Automatic text formatting</span>
				</div>
				<div class="flex items-center gap-2">
					<CheckIcon class="w-4 h-4 text-green-600" />
					<span class="text-sm">Application-specific responses</span>
				</div>
				<div class="flex items-center gap-2">
					<CheckIcon class="w-4 h-4 text-green-600" />
					<span class="text-sm">Privacy-focused processing</span>
				</div>
			</div>
		</Card.Content>
	</Card.Root>
</div>
