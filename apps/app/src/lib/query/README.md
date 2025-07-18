# Query Layer

The query layer is the reactive bridge between your UI components and the isolated service layer. It adds caching, reactivity, and state management on top of pure service functions.

## Static Site Generation Advantage

This application is fully static site generated and client-side only, which gives us a unique architectural advantage: direct access to the TanStack Query client.

Unlike server-side rendered applications where the query client lifecycle is managed by frameworks, our static approach means:

- Direct Query Client Access: We can call `queryClient.fetchQuery()` and `queryClient.getMutationCache().build()` directly
- Imperative Control: No need to go through reactive hooks for one-time operations
- Performance Benefits\*\*: We can build mutations using direct execution rather than creating unnecessary subscribers
- Flexible Interfaces: Both reactive (`.options()`) and imperative (`.execute()`, `.fetchCached()`) patterns work seamlessly

This enables our unique dual interface pattern where every query and mutation provides both reactive and imperative APIs.

## What is RPC?

**RPC** (Result Procedure Call) is our central namespace that bundles all query operations into one unified interface. Think of it as your app's "API client" that lives in the frontend:

```typescript
import { rpc } from '$lib/query';

// Everything you can do in the app is available through rpc.*
rpc.recordings.getAllRecordings;
rpc.transcription.transcribeRecording;
rpc.clipboard.copyToClipboard;
// ... and much more
```

The name "RPC" is inspired by Remote Procedure Calls, but adapted for our needs:

- **R**esult: Every operation returns a `Result<T, E>` type for consistent error handling
- **P**rocedure: Each operation is a well-defined procedure (query or mutation)
- **C**all: You can call these procedures reactively or imperatively

> **Author's Note**: I know, I know... "RPC" traditionally stands for "Remote Procedure Call," but I've reused the acronym to mean because it's fun and technically this builds off the Result type. People are already familiar with the RPC mental model, and honestly it just feels good to write `rpc`. Plus, it sounds way cooler than "query namespace" or whatever. 🤷‍♂️

## The .execute() Performance Advantage

When you call `createMutation()`, you're creating a _mutation observer_ that subscribes to reactive state changes. If you don't need the reactive state (like `isPending`, `isError`, etc.), you're paying a performance cost for functionality you're not using.

### Performance Comparison

```typescript
// ❌ createMutation() approach - Creates subscriber
const mutation = createMutation(rpc.recordings.createRecording.options());
// This creates a mutation observer that:
// - Subscribes to state changes
// - Triggers component re-renders
// - Manages reactive state (isPending, isError, etc.)
// - Adds memory overhead

// Then you call it:
mutation.mutate(recording);
```

```typescript
// ✅ .execute() approach - Direct execution
const { data, error } = await rpc.recordings.createRecording.execute(recording);
// This directly:
// - Executes the mutation immediately
// - Returns a simple Result<T, E>
// - No reactive state management
// - No component subscriptions
// - No memory overhead from observers
```

### When to Use Each Approach

**Use `.execute()` when:**

- Event handlers that just need the result
- Sequential operations in commands/workflows
- You don't need reactive state (isPending, etc.)
- Performance is critical
- Non-component code (services, utilities)

**Use `createMutation()` when:**

- You need reactive state for UI feedback
- Loading spinners, disable states, error displays
- The component needs to react to mutation state changes

## Why RPC?

Instead of importing individual queries from different files:

```typescript
// ❌ Without RPC (scattered imports)
import { getAllRecordings } from '$lib/query/recordings';
import { transcribeRecording } from '$lib/query/transcription';
import { copyToClipboard } from '$lib/query/clipboard';
```

You get everything through one clean namespace:

```typescript
// ✅ With RPC (unified interface)
import { rpc } from '$lib/query';

// Now you have intellisense for everything!
rpc.recordings.getAllRecordings;
rpc.transcription.transcribeRecording;
rpc.clipboard.copyToClipboard;
```

RPC provides:

- Unified Import: One import gives you access to everything
- Better DX: IntelliSense shows all available operations organized by domain
- Consistent Interface: Every operation follows the same dual-interface pattern
- Discoverability: Easy to explore what operations are available

## Architecture Philosophy

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│     UI      │ --> │  RPC/Query  │ --> │   Services   │
│ Components  │     │    Layer    │     │    (Pure)    │
└─────────────┘     └─────────────┘     └──────────────┘
      ↑                    │
      └────────────────────┘
         Reactive Updates
```

### How It Works

1. **Services**: Pure functions that do one thing (e.g., save to database, call an API)
2. **Query Layer**: Wraps services with TanStack Query for caching, reactivity, and error handling
3. **RPC Namespace**: Bundles all queries into one global object for easy access
4. **UI Components**: Use RPC to fetch/mutate data either reactively or imperatively

## Real-World RPC Usage Throughout the App

### 1. Reactive Queries in Components

```svelte
<!-- From: /routes/+page.svelte -->
<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';

	// These queries automatically update when data changes
	const recorderState = createQuery(
		rpc.manualRecorder.getRecorderState.options,
	);
	const latestRecording = createQuery(
		rpc.recordings.getLatestRecording.options,
	);
</script>

{#if $recorderState.data === 'RECORDING'}
	<RecordingIndicator />
{/if}

{#if $latestRecording.data}
	<RecordingCard recording={$latestRecording.data} />
{/if}
```

### 2. Imperative Mutations with Error Handling

```typescript
// From: /lib/deliverTextToUser.ts
// ✅ Direct execution - no reactive overhead
async function copyToClipboard(text: string) {
	const { error } = await rpc.clipboard.copyToClipboard.execute({ text });

	if (error) {
		toast.error({
			title: 'Error copying to clipboard',
			description: error.message,
			action: { type: 'more-details', error },
		});
	}
}

// ❌ Alternative with createMutation (unnecessary overhead)
// const copyMutation = createMutation(rpc.clipboard.copyToClipboard.options());
// copyMutation.mutate({ text }); // Creates observer, manages state we don't need
```

### 3. Sequential Operations - The .execute() Sweet Spot

```typescript
// From: /lib/commands.ts
// ✅ Perfect use case for .execute() - sequential workflow without UI reactivity
async function stopAndTranscribe() {
	// Step 1: Stop recording
	const { data: blob, error } = await rpc.manualRecorder.stopRecording.execute({
		toastId,
	});

	if (error) {
		toast.error({ title: 'Failed to stop recording' });
		return;
	}

	// Step 2: Play sound effect (fire-and-forget)
	rpc.sound.playSoundIfEnabled.execute('manual-stop');

	// Step 3: Create recording in database
	const { data: recording, error: createError } =
		await rpc.recordings.createRecording.execute({
			blob,
			timestamp: new Date(),
			transcriptionStatus: 'PENDING',
		});

	if (createError) return;

	// Step 4: Transcribe the recording
	await rpc.transcription.transcribeRecording.execute(recording);
}

// ❌ With createMutation (overkill for workflows)
// const stopMutation = createMutation(rpc.manualRecorder.stopRecording.options());
// const createMutation = createMutation(rpc.recordings.createRecording.options());
// Multiple observers created, state managed unnecessarily
```

### 4. Dynamic Queries with Parameters

```typescript
// From: /routes/(config)/settings/recording/SelectRecordingDevice.svelte
const deviceStrategy = $derived(settings.value['recording.device.strategy']);

// Query automatically re-runs when deviceStrategy changes
const devices = createQuery(rpc.device.getDevices(deviceStrategy).options);
```

### 5. Options Factory Pattern for Conditional Queries

```typescript
// From: /routes/+layout/alwaysOnTop.svelte.ts
const recorderStateQuery = createQuery(() => ({
	...rpc.manualRecorder.getRecorderState.options(),
	// Only enable this query when in manual recording mode
	enabled: settings.value['recording.mode'] === 'manual',
}));

const vadStateQuery = createQuery(() => ({
	...rpc.vadRecorder.getVadState.options(),
	// Only enable when using voice activity detection
	enabled: settings.value['recording.mode'] === 'vad',
}));
```

### 6. Direct Function Calls (Synchronous Operations)

```typescript
// Some RPC methods are direct functions, not queries/mutations
if (rpc.transcription.isCurrentlyTranscribing()) {
	showTranscribingIndicator();
}
```

### 7. Batch Mutations in UI

```svelte
<!-- From: /routes/(config)/recordings/+page.svelte -->
<script lang="ts">
	const transcribeRecordings = createMutation(
		rpc.transcription.transcribeRecordings.options,
	);
	const deleteRecordings = createMutation(
		rpc.recordings.deleteRecordings.options,
	);

	async function handleBulkAction(selectedIds: string[]) {
		if (action === 'transcribe') {
			$transcribeRecordings.mutate(selectedIds);
		} else if (action === 'delete') {
			$deleteRecordings.mutate(selectedIds);
		}
	}
</script>
```

## Getting Started with RPC

The easiest way to understand RPC is to see it in action. Here's how you'd fetch and display recordings:

```svelte
<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';

	// This automatically subscribes to all recordings
	const recordingsQuery = createQuery(rpc.recordings.getAllRecordings.options);
</script>

{#if recordingsQuery.isPending}
	<p>Loading recordings...</p>
{:else if recordingsQuery.error}
	<p>Error: {recordingsQuery.error.message}</p>
{:else if recordingsQuery.data}
	{#each recordingsQuery.data as recording}
		<RecordingCard {recording} />
	{/each}
{/if}
```

That's it! The query automatically:

- Fetches data when the component mounts
- Caches results to avoid unnecessary requests
- Refetches when you return to the page
- Updates when recordings change elsewhere in the app

## Core Utilities

### `defineQuery` and `defineMutation` - Enabled by Direct Client Access

Our factory functions in `_utils.ts` provide a consistent dual interface pattern that's only possible because we have direct access to the query client:

```typescript
// Define a query with automatic error handling via Result types
const userQuery = defineQuery({
	queryKey: ['users', userId],
	resultQueryFn: () => services.getUser(userId), // Returns Result<User, Error>
});

// ✅ Reactive interface - creates query observer
const query = createQuery(userQuery.options());
// - Subscribes to state changes
// - Manages loading, error, success states
// - Triggers component re-renders

// ✅ Imperative interface - direct query client usage
const { data, error } = await userQuery.fetchCached();
// - Calls queryClient.fetchQuery() directly
// - Returns cached data if fresh
// - No reactive overhead
```

**This dual interface is powered by direct query client access:**

- `.options()` returns standard TanStack Query configuration
- `.fetchCached()` calls `queryClient.fetchQuery()` under the hood
- `.execute()` uses `queryClient.getMutationCache().build()` for direct execution

### Why Result Types?

We use `Result<T, E>` types everywhere to ensure consistent error handling:

- No thrown exceptions in normal flow
- Type-safe error handling
- Better IDE support and autocomplete
- Easier testing

## Common Patterns

### 1. Basic Query Definition

```typescript
export const recordings = {
	getAllRecordings: defineQuery({
		queryKey: ['recordings'],
		resultQueryFn: () => services.db.getAllRecordings(),
	}),
};
```

### 2. Parameterized Queries

```typescript
getRecordingById: (id: Accessor<string>) =>
  defineQuery({
    queryKey: ['recordings', id()], // Dynamic key based on ID
    resultQueryFn: () => services.db.getRecordingById(id()),
  }),
```

### 3. Mutations with Cache Updates

```typescript
createRecording: defineMutation({
  mutationKey: ['recordings', 'create'],
  resultMutationFn: async (recording: Recording) => {
    const result = await services.db.createRecording(recording);
    if (result.error) return Err(result.error);

    // Optimistically update cache
    queryClient.setQueryData(['recordings'], (old) =>
      [...(old || []), recording]
    );

    return Ok(result.data);
  },
}),
```

### 4. Settings-Dependent Operations

```typescript
// Transcription uses current settings dynamically
function transcribeBlob(blob: Blob) {
	return services.transcription().transcribe(blob, {
		outputLanguage: settings.value['transcription.outputLanguage'],
		prompt: settings.value['transcription.prompt'],
		temperature: settings.value['transcription.temperature'],
	});
}
```

### 5. Multi-Step Operations

```typescript
transcribeRecording: defineMutation({
  resultMutationFn: async (recording) => {
    // Step 1: Update status
    await recordings.updateRecording.execute({
      ...recording,
      transcriptionStatus: 'TRANSCRIBING',
    });

    // Step 2: Perform transcription
    const { data, error } = await transcribeBlob(recording.blob);

    // Step 3: Update with results
    await recordings.updateRecording.execute({
      ...recording,
      transcribedText: data,
      transcriptionStatus: error ? 'FAILED' : 'DONE',
    });

    return error ? Err(error) : Ok(data);
  },
}),
```

## Usage in Components

### Reactive Usage (Recommended for UI)

```svelte
<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { rpc } from '$lib/query';

	// This automatically subscribes to updates
	const recordings = createQuery(rpc.recordings.getAllRecordings.options());
</script>

{#if recordings.isLoading}
	<p>Loading...</p>
{:else if recordings.error}
	<p>Error: {recordings.error.message}</p>
{:else}
	{#each recordings.data as recording}
		<RecordingCard {recording} />
	{/each}
{/if}
```

### Imperative Usage (For Actions)

```typescript
async function handleDelete(recording: Recording) {
	const { error } = await rpc.recordings.deleteRecording.execute(recording);

	if (error) {
		toast.error({
			title: 'Failed to delete',
			description: error.message,
		});
	}
}
```

## File Organization

- `_utils.ts` - Core factory functions
- `index.ts` - Query client setup and unified `rpc` export
- Feature-specific files (e.g., `recordings.ts`, `transcription.ts`)

Each feature file typically exports an object with:

- Query definitions
- Mutation definitions
- Helper functions
- Utility methods

## Best Practices

1. Always use Result types - Never throw errors in query/mutation functions
2. Choose the right interface for the job:
   - Use `.execute()` for event handlers, workflows, and performance-critical operations
   - Use `createMutation()` when you need reactive state for UI feedback
3. Keep queries simple - Complex logic belongs in services or orchestration mutations
4. Update cache optimistically - Better UX for mutations
5. Use proper query keys - Hierarchical and consistent
6. Leverage direct client access - Our static architecture enables powerful patterns unavailable in SSR apps

## Quick Reference: Common RPC Patterns

### Basic Query (Reactive)

```typescript
// In component
const recordingsQuery = createQuery(rpc.recordings.getAllRecordings.options);

// In template
{#if recordingsQuery.isPending}Loading...{/if}
{#if recordingsQuery.data}{recordingsQuery.data}{/if}
```

### Query with Parameters

```typescript
// Define with accessor
const recordingId = () => '123';
const recordingQuery = createQuery(
	rpc.recordings.getRecordingById(recordingId).options,
);
```

### Basic Mutation (Reactive)

```typescript
const deleteRecordingMutation = createMutation(
	rpc.recordings.deleteRecording.options,
);

// Trigger mutation
deleteRecordingMutation.mutate(recordingId);
```

### Imperative Execute - Performance Optimized

```typescript
// ✅ Queries - uses queryClient.fetchQuery() directly
const { data, error } = await rpc.recordings.getAllRecordings.fetchCached();
// - Returns cached data if fresh
// - No reactive subscription
// - Perfect for prefetching or one-time fetches

// ✅ Mutations - uses queryClient.getMutationCache().build() directly
const { data, error } = await rpc.recordings.createRecording.execute(recording);
// - Direct execution without mutation observer
// - No reactive state management overhead
// - Ideal for event handlers and workflows
```

### Error Handling Pattern

```typescript
const { data, error } = await rpc.clipboard.copyToClipboard.execute({ text });
if (error) {
	toast.error({
		title: 'Failed to copy',
		description: error.message,
	});
	return;
}
// Success path continues...
```

### Conditional Queries

```typescript
const vadStateQuery = createQuery(() => ({
	...rpc.vadRecorder.getVadState.options(),
	enabled: settings.value['recording.mode'] === 'vad',
}));
```

### Cache Updates in Mutations

```typescript
defineMutation({
	resultMutationFn: async (recording) => {
		const result = await services.db.createRecording(recording);
		if (result.error) return Err(result.error);

		// Update cache
		queryClient.setQueryData(['recordings'], (old) => [
			...(old || []),
			recording,
		]);

		return Ok(result.data);
	},
});
```

### Settings-Dependent Operations

```typescript
// Query layer automatically uses current settings
function transcribeBlob(blob: Blob) {
	return services.transcription().transcribe(blob, {
		outputLanguage: settings.value['transcription.outputLanguage'],
		temperature: settings.value['transcription.temperature'],
	});
}
```

## The Three Layers Explained

Understanding how RPC fits into the bigger picture:

### 1. Services Layer (`/lib/services/`)

Pure functions that do the actual work:

```typescript
// services/db.ts
export async function getAllRecordings(): Promise<
	Result<Recording[], DbError>
> {
	try {
		const recordings = await database.recordings.findMany();
		return Ok(recordings);
	} catch (error) {
		return Err(new DbError('Failed to fetch recordings'));
	}
}
```

### 2. Query Layer (`/lib/query/`)

Wraps services with reactivity and caching:

```typescript
// query/recordings.ts
export const recordings = {
	getAllRecordings: defineQuery({
		queryKey: ['recordings'],
		resultQueryFn: () => services.db.getAllRecordings(), // Calls the service
	}),
};
```

### 3. RPC Namespace (`/lib/query/index.ts`)

Bundles everything for easy access:

```typescript
// query/index.ts
export const rpc = {
	recordings, // Contains getAllRecordings and other recording operations
	transcription, // Contains transcribe and other transcription operations
	// ... all other feature modules
};
```

### 4. Component Usage

Use RPC in your components:

```svelte
<script>
	import { rpc } from '$lib/query';

	// Reactive usage
	const recordingsQuery = createQuery(rpc.recordings.getAllRecordings.options);

	// Imperative usage
	async function deleteRecording(id) {
		const { error } = await rpc.recordings.deleteRecording.execute(id);
	}
</script>
```

## Adding New Features

When you need to add new functionality:

1. **Create a service** in `/services` with pure business logic
2. **Create a query wrapper** in `/query` that adds:
   - TanStack Query integration
   - Cache management
   - Settings reactivity
   - Error handling
3. **Export from RPC** in `index.ts` so it's available globally
4. **Use in components** via either reactive or imperative patterns

This keeps everything organized and testable while giving you a unified way to access all app functionality.
