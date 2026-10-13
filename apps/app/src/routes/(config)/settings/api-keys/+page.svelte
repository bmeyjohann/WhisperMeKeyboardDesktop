<script lang="ts">
	import { Separator } from '$lib/components/ui/separator/index.js';
	import {
		AnthropicApiKeyInput,
		ElevenLabsApiKeyInput,
		GoogleApiKeyInput,
		GroqApiKeyInput,
		OpenAiApiKeyInput,
	} from '$lib/components/settings';
</script>

<svelte:head>
	<title>API Keys - WhisperMe</title>
</svelte:head>

<div class="space-y-6">
	<div>
		<h3 class="text-lg font-medium">API Keys</h3>
		<p class="text-muted-foreground text-sm">
			Configure your API keys for WhisperMe.
		</p>
	</div>
	<Separator />

	<OpenAiApiKeyInput />
	<AnthropicApiKeyInput />
	<GroqApiKeyInput />
	<GoogleApiKeyInput />
	<ElevenLabsApiKeyInput />
</div>
