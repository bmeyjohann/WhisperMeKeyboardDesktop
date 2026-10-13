<script lang="ts">
 import { auth0Service, isAuthenticated, authError, isAuthLoading } from '$lib/services/auth0';
 export { isAuthenticated };
</script>
{#if !$isAuthenticated}
 <section class="rounded-xl border p-5 space-y-3" aria-label="Sign in">
  <h2 class="font-medium">Sign in to start dictating</h2>
  <p class="text-sm text-muted-foreground">Your transcripts stay on this device. Sign in to use voice processing.</p>
  {#if $authError}<p role="alert" class="text-sm text-red-500">{$authError}</p>{/if}
  <button class="rounded-lg bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" disabled={$isAuthLoading} onclick={() => auth0Service.login()}>{$isAuthLoading ? 'Signing in…' : 'Sign in'}</button>
  {#if $authError}<button class="ml-3 text-sm underline" onclick={() => auth0Service.checkSession()}>Retry connection</button>{/if}
 </section>
{/if}
