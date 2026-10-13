<script lang="ts">
 let { class: className = '', collapsed = false }: {class?: string; collapsed?: boolean} = $props();
</script>
<nav class={className} aria-label="Navigation">
 <a href="/">Transcripts</a><a href="/settings/transcription">Voice settings</a>
</nav>
<style>nav{display:flex;gap:16px;font-size:14px}a{text-decoration:underline}</style>
