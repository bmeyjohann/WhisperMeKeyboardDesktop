<script lang="ts">
	import { auth0Service, isAuthenticated, authUser, authError, isAuthLoading } from '$lib/services/auth0';
	import { apiClient } from '$lib/services/httpClient';

	// Example of making an authenticated API call
	async function makeApiCall() {
		try {
			// The apiClient automatically includes auth headers if the user is authenticated
			const response = await apiClient.get('/voice-processing/history', { requireAuth: true });
			console.log('API Response:', response);
		} catch (error) {
			console.error('API call failed:', error);
		}
	}

	// Example of uploading a voice file
	async function uploadVoiceFile(file: File) {
		try {
			const response = await apiClient.uploadFile(
				'/voice-processing/upload',
				file,
				{ userId: $authUser?.sub || '' },
				{ requireAuth: true }
			);
			console.log('Upload successful:', response);
		} catch (error) {
			console.error('Upload failed:', error);
		}
	}

	// Handle file input
	function handleFileUpload(event: Event) {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		if (file) {
			uploadVoiceFile(file);
		}
	}
</script>

<!-- Loading state -->
{#if $isAuthLoading}
	<div class="loading">
		<p>Loading authentication...</p>
	</div>

<!-- Error state -->
{:else if $authError}
	<div class="error">
		<p>Authentication error: {$authError}</p>
		<button on:click={() => window.location.reload()}>Retry</button>
	</div>

<!-- Authenticated state -->
{:else if $isAuthenticated && $authUser}
	<div class="authenticated">
		<h2>Welcome, {$authUser.name || $authUser.email}!</h2>
		
		<div class="user-info">
			<p><strong>Email:</strong> {$authUser.email}</p>
			{#if $authUser.picture}
				<img src={$authUser.picture} alt="Profile" class="profile-picture" />
			{/if}
		</div>

		<div class="actions">
			<button on:click={makeApiCall}>Test API Call</button>
			<input type="file" accept="audio/*" on:change={handleFileUpload} />
			<button on:click={() => auth0Service.logout()}>Logout</button>
		</div>
	</div>

<!-- Unauthenticated state -->
{:else}
	<div class="unauthenticated">
		<h2>Welcome to WhisperMe</h2>
		<p>Please log in to access your voice processing features.</p>
		<button on:click={() => auth0Service.login()}>Login</button>
	</div>
{/if}

<style>
	.loading,
	.error,
	.authenticated,
	.unauthenticated {
		padding: 2rem;
		text-align: center;
		max-width: 400px;
		margin: 0 auto;
	}

	.error {
		background-color: #fee;
		border: 1px solid #f99;
		border-radius: 8px;
	}

	.user-info {
		margin: 1rem 0;
		padding: 1rem;
		background-color: #f5f5f5;
		border-radius: 8px;
	}

	.profile-picture {
		width: 64px;
		height: 64px;
		border-radius: 50%;
		margin-top: 0.5rem;
	}

	.actions {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 2rem;
	}

	button {
		padding: 0.75rem 1.5rem;
		background-color: #0284c7;
		color: white;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-size: 1rem;
	}

	button:hover {
		background-color: #0369a1;
	}

	button:disabled {
		background-color: #94a3b8;
		cursor: not-allowed;
	}

	input[type='file'] {
		padding: 0.5rem;
		border: 1px solid #d1d5db;
		border-radius: 6px;
	}
</style> 