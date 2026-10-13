<script lang="ts">
 import { page } from '$app/state';
 let { children } = $props();
</script>
<main class="mx-auto w-full max-w-3xl px-6 py-8">
 {#if !['/settings', '/settings/transcription', '/settings/account'].includes(page.url.pathname)}
  <a class="mb-6 inline-block text-sm underline" href="/settings/transcription">Back to Voice settings</a>
 {/if}
 {@render children()}
</main>
