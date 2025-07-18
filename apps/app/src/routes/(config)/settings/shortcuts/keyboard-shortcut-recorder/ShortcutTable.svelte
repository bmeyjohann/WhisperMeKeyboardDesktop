<script lang="ts">
	import { commands } from '$lib/commands';
	import { Input } from '$lib/components/ui/input/index.js';
	import * as Table from '$lib/components/ui/table/index.js';
	import { createPressedKeys } from '$lib/utils/createPressedKeys.svelte';
	import { Search } from 'lucide-svelte';
	import GlobalKeyboardShortcutRecorder from './GlobalKeyboardShortcutRecorder.svelte';
	import LocalKeyboardShortcutRecorder from './LocalKeyboardShortcutRecorder.svelte';
	import { toast } from '$lib/toast';
	import { getDefaultSettings } from '$lib/settings';

	let { type }: { type: 'local' | 'global' } = $props();

	let searchQuery = $state('');

	const defaultSettings = getDefaultSettings();

	const filteredCommands = $derived(
		commands.filter((command) =>
			command.title.toLowerCase().includes(searchQuery.toLowerCase()),
		),
	);

	const pressedKeys = createPressedKeys({
		onUnsupportedKey: (key) => {
			toast.warning({
				title: 'Unsupported key',
				description: `The key "${key}" is not supported. Please try a different key.`,
			});
		},
	});
</script>

<div class="space-y-4">
	<!-- Search input -->
	<div class="relative">
		<Search
			class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
		/>
		<Input
			type="search"
			placeholder="Search commands..."
			class="pl-10"
			bind:value={searchQuery}
		/>
	</div>

	<!-- Command list with shortcuts -->
	<div class="overflow-x-auto rounded-lg border">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="min-w-[150px]">Command</Table.Head>
					<Table.Head class="text-right min-w-[200px]">Shortcut</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each filteredCommands as command}
					{@const defaultShortcut =
						defaultSettings[`shortcuts.${type}.${command.id}`]}
					<Table.Row>
						<Table.Cell class="font-medium">
							<span class="block truncate pr-2">{command.title}</span>
						</Table.Cell>
						<Table.Cell class="text-right">
							{#if type === 'local'}
								<LocalKeyboardShortcutRecorder
									{command}
									placeholder={defaultShortcut
										? `Default: ${defaultShortcut}`
										: 'Set shortcut'}
									{pressedKeys}
								/>
							{:else}
								<GlobalKeyboardShortcutRecorder
									{command}
									placeholder={defaultShortcut
										? `Default: ${defaultShortcut}`
										: 'Set shortcut'}
									{pressedKeys}
								/>
							{/if}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
</div>
