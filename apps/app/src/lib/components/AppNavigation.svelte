<script lang="ts">
 import { page } from '$app/state';
</script>
<header class="app-navigation">
 <a class="brand" href="/" aria-label="WhisperMe — Transcripts">WhisperMe</a>
 <nav aria-label="Main navigation">
  <a href="/" aria-current={page.url.pathname === '/' ? 'page' : undefined}>Transcripts</a>
  <a href="/settings/transcription" aria-current={page.url.pathname.startsWith('/settings') && !page.url.pathname.startsWith('/settings/account') ? 'page' : undefined}>Voice settings</a>
  <a href="/settings/account" aria-current={page.url.pathname.startsWith('/settings/account') ? 'page' : undefined}>Account</a>
 </nav>
</header>
<style>
 .app-navigation{position:sticky;top:0;z-index:40;display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;padding:16px 24px;background:var(--background);border-bottom:1px solid var(--border)}
 .brand{font-size:18px;font-weight:650;letter-spacing:-.5px}nav{display:flex;gap:8px}nav a{padding:8px 12px;border-radius:8px;font-size:14px;color:var(--muted-foreground)}nav a[aria-current="page"]{background:var(--muted);color:var(--foreground)}a:focus-visible{outline:2px solid currentColor;outline-offset:3px}@media(max-width:480px){.app-navigation{padding:12px;gap:8px}nav{gap:0}nav a{padding:8px;font-size:13px}}
</style>
