<script lang="ts">
 import AppNavigation from '$lib/components/AppNavigation.svelte';
 import { page } from '$app/state';
 import { usesRealtimeVoice, toggleRealtimeVoice, isVoiceSessionActive } from '$lib/services/realtime-voice';
	import { goto } from '$app/navigation';
	import { commandCallbacks } from '$lib/commands';
	import ConfirmationDialog from '$lib/components/ConfirmationDialog.svelte';
	import MoreDetailsDialog from '$lib/components/MoreDetailsDialog.svelte';
	import NotificationLog from '$lib/components/NotificationLog.svelte';
	import UpdateDialog from '$lib/components/UpdateDialog.svelte';
	import { rpc } from '$lib/query';
	import * as services from '$lib/services';
	// import { extension } from '@repo/extension';
	import { createQuery } from '@tanstack/svelte-query';
	import { ModeWatcher, mode } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { Toaster, type ToasterProps } from 'svelte-sonner';
	import { listen } from '@tauri-apps/api/event';
	import { syncWindowAlwaysOnTopWithRecorderState } from './alwaysOnTop.svelte';
	import { closeToTrayIfEnabled } from './closeToTrayIfEnabled';
	import { checkForUpdates } from './check-for-updates';
	import {
		resetGlobalShortcutsToDefaultIfDuplicates,
		resetLocalShortcutsToDefaultIfDuplicates,
		syncGlobalShortcutsWithSettings,
		syncLocalShortcutsWithSettings,
	} from './register-commands';
	import { registerOnboarding } from './register-onboarding';
	import { syncIconWithRecorderState } from './syncIconWithRecorderState.svelte';
	import { settings } from '$lib/stores/settings.svelte';
	import { auth0Service, isAuthenticated, authUser, isAuthLoading, authError } from '$lib/services/auth0';
	import LoginScreen from '$lib/components/LoginScreen.svelte';

    const localTest = auth0Service.localTest;
	const sessionChecking = auth0Service.sessionChecking;
 let startupChecked = $state(false);
	const getRecorderStateQuery = createQuery(
		rpc.manualRecorder.getRecorderState.options,
	);
	const getCpalStateQuery = createQuery(rpc.cpalRecorder.getRecorderState.options);
	const getVadStateQuery = createQuery(rpc.vadRecorder.getVadState.options);

	onMount(() => {
		const checkSession = () => {
			if (!isVoiceSessionActive() && getRecorderStateQuery.data !== 'RECORDING' &&
				getCpalStateQuery.data !== 'RECORDING') void auth0Service.checkSession().finally(() => { startupChecked = true; });
		};
		checkSession();
		window.addEventListener('focus', checkSession);
		window.addEventListener('online', checkSession);
		const sessionTimer = window.setInterval(checkSession, 60_000);
		window.commands = commandCallbacks;
		window.goto = goto;
		syncLocalShortcutsWithSettings();
		resetLocalShortcutsToDefaultIfDuplicates();
		registerOnboarding();
		if (window.__TAURI_INTERNALS__) {
			syncGlobalShortcutsWithSettings();
			resetGlobalShortcutsToDefaultIfDuplicates();
			checkForUpdates();
		} else {
			// const _notifyWhisperMeTabReadyResult =
			// await extension.notifyWhisperMeTabReady(undefined);
		}

		let overlayUnlisten: (() => void) | undefined;
		if (window.__TAURI_INTERNALS__) {
			listen('stop-recording-requested', async () => {
 if (usesRealtimeVoice()) return toggleRealtimeVoice();
				console.info('Stop recording requested from overlay');

				const currentState = getRecorderStateQuery.data;
				if (currentState === 'RECORDING') {
					await commandCallbacks.toggleManualRecording();
				}

				const cpalState = getCpalStateQuery.data;
				if (cpalState === 'RECORDING') {
					await commandCallbacks.toggleCpalRecording();
				}
			}).then((unlisten) => {
				overlayUnlisten = unlisten;
			});
		}

		return () => {
			window.removeEventListener('focus', checkSession);
			window.removeEventListener('online', checkSession);
			window.clearInterval(sessionTimer);
			overlayUnlisten?.();
		};
	});


	closeToTrayIfEnabled();

	if (window.__TAURI_INTERNALS__) {
		syncWindowAlwaysOnTopWithRecorderState();
		syncIconWithRecorderState();
	}

	$effect(() => {
		getRecorderStateQuery.data;
		getVadStateQuery.data;
		services.db.cleanupExpiredRecordings({
			recordingRetentionStrategy:
				settings.value['database.recordingRetentionStrategy'],
			maxRecordingCount: settings.value['database.maxRecordingCount'],
		});
	});

	const TOASTER_SETTINGS = {
		position: 'bottom-right',
		richColors: true,
		duration: 5000,
		visibleToasts: 5,
		toastOptions: {
			classes: {
				toast: 'flex flex-wrap [&>[data-content]]:flex-1',
				icon: 'flex-shrink-0',
				actionButton: 'w-full mt-3 inline-flex justify-center',
				closeButton: 'w-full mt-3 inline-flex justify-center',
			},
		},
	} satisfies ToasterProps;

	let { children } = $props();
</script>

{#if $localTest}<div role="status" class="bg-blue-100 p-2 text-center text-sm text-blue-950">Local test · loopback server · account services disabled</div>{/if}

<!-- Show login screen if not authenticated -->
{#if $sessionChecking && !$isAuthenticated && !startupChecked}
	<p role="status" class="p-6">Checking your session…</p>
{:else if !$isAuthenticated && !['/', '/settings', '/settings/transcription'].includes(page.url.pathname)}
	<LoginScreen />
    <a class="text-sm underline" href="/settings/transcription">Voice settings</a>
{:else}
	{#if $authError && $isAuthenticated}<div role="alert" class="p-3">{$authError} <button class="underline" onclick={() => auth0Service.checkSession()}>Retry session check</button></div>{/if}
	<!-- Main app content for authenticated users -->
	<button
		class="xxs:hidden hover:bg-accent hover:text-accent-foreground h-screen w-screen transform duration-300 ease-in-out"
		onclick={commandCallbacks.toggleManualRecording}
	>
		<span
			style="filter: drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.5));"
			class="text-[48px] leading-none"
		>
			{#if getRecorderStateQuery.data === 'RECORDING'}
				⏹️
			{:else}
				🎙️
			{/if}
		</span>
	</button>

	<div class="xxs:flex hidden min-h-screen w-full flex-col items-center">
        <AppNavigation />
        {#if !$isAuthenticated}<div class="w-full max-w-3xl px-6 py-4"><LoginScreen /></div>{/if}
		{@render children()}
	</div>
{/if}

<Toaster
	offset={16}
	class="xs:block hidden"
	theme={mode.current}
	{...TOASTER_SETTINGS}
/>
<ModeWatcher />
<ConfirmationDialog />
<MoreDetailsDialog />
<NotificationLog />
<UpdateDialog />
