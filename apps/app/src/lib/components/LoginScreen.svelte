<script lang="ts">
	import { auth0Service, isAuthenticated, authUser, authError, isAuthLoading } from '$lib/services/auth0';

	// Re-export for parent component to watch
	export { isAuthenticated };
</script>

<!-- Loading state -->
{#if $isAuthLoading}
	<div class="flex min-h-screen items-center justify-center bg-background">
		<div class="text-center">
			<div class="mb-4 flex justify-center">
				<div class="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
			</div>
			<p class="text-muted-foreground">Loading authentication...</p>
		</div>
	</div>

<!-- Error state -->
{:else if $authError}
	<div class="flex min-h-screen items-center justify-center bg-background p-8">
		<div class="w-full max-w-md">
			<div class="rounded-lg border border-destructive bg-destructive/10 p-6">
				<h2 class="mb-4 text-xl font-semibold text-destructive">Authentication Error</h2>
				<p class="mb-4 text-sm text-destructive">{$authError}</p>
				<button
					class="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
					onclick={() => window.location.reload()}
				>
					Retry
				</button>
			</div>
		</div>
	</div>

<!-- Login screen for unauthenticated users -->
{:else if !$isAuthenticated}
	<div class="flex min-h-screen items-center justify-center bg-background p-8">
		<div class="w-full max-w-md space-y-8">
			<!-- App Icon/Logo -->
			<div class="text-center">
				<div class="mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-primary text-4xl text-primary-foreground">
					🎤
				</div>
				<h1 class="mt-6 text-3xl font-bold tracking-tight text-foreground">WhisperMe</h1>
				<p class="mt-2 text-muted-foreground">AI-Enhanced Voice Keyboard</p>
			</div>

			<!-- Welcome content -->
			<div class="space-y-6">
				<div class="text-center">
					<h2 class="text-xl font-semibold text-foreground">Welcome to WhisperMe</h2>
					<p class="mt-3 text-sm text-muted-foreground leading-relaxed">
						Please sign in to access your personalized voice processing features and sync your settings across devices.
					</p>
				</div>

				<!-- Login button -->
				<button
					class="w-full rounded-lg bg-primary px-4 py-3 text-primary-foreground hover:bg-primary/90 transition-colors font-medium"
					onclick={() => auth0Service.login()}
				>
					Sign In
				</button>

				<!-- Footer text -->
				<div class="space-y-3 text-center">
					<p class="text-xs text-muted-foreground leading-relaxed">
						By signing in, you agree to our Terms of Service and Privacy Policy
					</p>
					<p class="text-xs text-muted-foreground">
						Secure authentication powered by Auth0
					</p>
				</div>
			</div>
		</div>
	</div>
{/if} 