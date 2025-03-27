<script lang="ts">
	import { initCommandsInContext } from '$lib/query/singletons/commands';
	import { initManualRecorderInContext } from '$lib/query/singletons/manualRecorder';
	import { initShortcutsRegisterInContext } from '$lib/query/singletons/shortcutsRegister';
	import { initVadRecorderInContext } from '$lib/query/singletons/vadRecorder';

	const manualRecorder = initManualRecorderInContext();
	const vadRecorder = initVadRecorderInContext();
	const commandCallbacks = initCommandsInContext({
		manualRecorder,
		vadRecorder,
	});
	const shortcutsRegister = initShortcutsRegisterInContext({
		commandCallbacks,
	});

	let { children } = $props();
</script>

{@render children()}
