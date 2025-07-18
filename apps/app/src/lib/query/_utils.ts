import { Err, Ok, resolve, type Result } from 'wellcrafted/result';
import type {
	CreateQueryOptions,
	MutationFunction,
	MutationKey,
	MutationOptions,
	QueryFunction,
	QueryFunctionContext,
	QueryKey,
} from '@tanstack/svelte-query';
import { queryClient } from './index';
import type { RecordingMode } from '$lib/constants/audio';

/**
 * Creates a query definition that bridges the gap between pure service functions and reactive UI components.
 *
 * This factory function is the cornerstone of our data fetching architecture. It wraps service calls
 * with TanStack Query superpowers while maintaining type safety through Result types.
 *
 * ## Why use defineQuery?
 *
 * 1. **Dual Interface**: Provides both reactive (`.options()`) and imperative (`.fetchCached()`) APIs
 * 2. **Automatic Error Handling**: Service functions return `Result<T, E>` types which are automatically
 *    unwrapped by TanStack Query, giving you proper error states in your components
 * 3. **Type Safety**: Full TypeScript support with proper inference for data and error types
 * 4. **Consistency**: Every query in the app follows the same pattern, making it easy to understand
 *
 * @template TQueryFnData - The type of data returned by the query function
 * @template TError - The type of error that can be thrown
 * @template TData - The type of data returned by the query (after select transform)
 * @template TQueryKey - The type of the query key
 *
 * @param options - Query configuration object
 * @param options.queryKey - Unique key for this query (used for caching and refetching)
 * @param options.resultQueryFn - Function that fetches data and returns a Result type
 * @param options.* - Any other TanStack Query options (staleTime, refetchInterval, etc.)
 *
 * @returns Query definition object with two methods:
 *   - `options()`: Returns config for use with createQuery() in Svelte components
 *   - `fetchCached()`: Imperatively fetches data (useful for actions/event handlers)
 *
 * @example
 * ```typescript
 * // Step 1: Define your query in the query layer
 * const userQuery = defineQuery({
 *   queryKey: ['users', userId],
 *   resultQueryFn: () => services.getUser(userId), // Returns Result<User, ApiError>
 *   staleTime: 5 * 60 * 1000, // Consider data fresh for 5 minutes
 * });
 *
 * // Step 2a: Use reactively in a Svelte component
 * const query = createQuery(userQuery.options());
 * // $query.data is User | undefined
 * // $query.error is ApiError | null
 *
 * // Step 2b: Use imperatively in an action
 * async function prefetchUser() {
 *   const { data, error } = await userQuery.fetchCached();
 *   if (error) {
 *     console.error('Failed to fetch user:', error);
 *   }
 * }
 * ```
 */
export function defineQuery<
	TQueryFnData,
	TError,
	TData = TQueryFnData,
	TQueryKey extends QueryKey = QueryKey,
>(
	options: Omit<
		CreateQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
		'queryFn'
	> & {
		queryKey: TQueryKey;
		resultQueryFn: QueryFunction<Result<TQueryFnData, TError>, TQueryKey>;
	},
) {
	const newOptions = {
		...options,
		queryFn: async (context: QueryFunctionContext<TQueryKey>) => {
			let result = options.resultQueryFn(context);
			if (result instanceof Promise) result = await result;
			return resolve(result);
		},
	} satisfies CreateQueryOptions<TQueryFnData, TError, TData, TQueryKey>;

	return {
		/**
		 * Returns the query options for reactive usage with TanStack Query hooks.
		 * Use this with `createQuery()` in Svelte components for automatic subscriptions.
		 * @returns The query options object configured for TanStack Query
		 */
		options: () => newOptions,

		/**
		 * Fetches data for this query, returning cached data if fresh or refetching if stale/missing.
		 *
		 * This method is perfect for:
		 * - Prefetching data before navigation
		 * - Loading data in response to user actions
		 * - Accessing query data outside of components
		 *
		 * @returns Promise that resolves with a Result containing either the data or an error
		 *
		 * @example
		 * const { data, error } = await userQuery.fetchCached();
		 * if (error) {
		 *   console.error('Failed to load user:', error);
		 * }
		 */
		async fetchCached(): Promise<Result<TData, TError>> {
			try {
				return Ok(
					await queryClient.fetchQuery<TQueryFnData, Error, TData, TQueryKey>({
						queryKey: newOptions.queryKey,
						queryFn: newOptions.queryFn,
					}),
				);
			} catch (error) {
				return Err(error as TError);
			}
		},
	};
}

/**
 * Creates a mutation definition for operations that modify data (create, update, delete).
 *
 * This factory function is the mutation counterpart to defineQuery. It provides a clean way to
 * wrap service functions that perform side effects, while maintaining the same dual interface
 * pattern for maximum flexibility.
 *
 * ## Why use defineMutation?
 *
 * 1. **Dual Interface**: Just like queries, mutations can be used reactively or imperatively
 * 2. **Direct Execution**: The `.execute()` method lets you run mutations without creating hooks,
 *    perfect for event handlers and non-component code
 * 3. **Consistent Error Handling**: Service functions return `Result<T, E>` types, ensuring
 *    errors are handled consistently throughout the app
 * 4. **Cache Management**: Mutations often update the cache after success (see examples)
 *
 * @template TData - The type of data returned by the mutation
 * @template TError - The type of error that can be thrown
 * @template TVariables - The type of variables passed to the mutation
 * @template TContext - The type of context data for optimistic updates
 *
 * @param options - Mutation configuration object
 * @param options.mutationKey - Unique key for this mutation (used for tracking in-flight state)
 * @param options.resultMutationFn - Function that performs the mutation and returns a Result type
 * @param options.* - Any other TanStack Mutation options (onSuccess, onError, etc.)
 *
 * @returns Mutation definition object with two methods:
 *   - `options()`: Returns config for use with createMutation() in Svelte components
 *   - `execute()`: Directly executes the mutation and returns a Result
 *
 * @example
 * ```typescript
 * // Step 1: Define your mutation with cache updates
 * const createRecording = defineMutation({
 *   mutationKey: ['recordings', 'create'],
 *   resultMutationFn: async (recording: Recording) => {
 *     // Call the service
 *     const result = await services.db.createRecording(recording);
 *     if (result.error) return Err(result.error);
 *
 *     // Update cache on success
 *     queryClient.setQueryData(['recordings'], (old) =>
 *       [...(old || []), recording]
 *     );
 *
 *     return Ok(result.data);
 *   }
 * });
 *
 * // Step 2a: Use reactively in a component
 * const mutation = createMutation(createRecording.options());
 * // Call with: $mutation.mutate(recordingData)
 *
 * // Step 2b: Use imperatively in an action
 * async function saveRecording(data: Recording) {
 *   const { error } = await createRecording.execute(data);
 *   if (error) {
 *     toast.error({ title: 'Failed to save', description: error.message });
 *   } else {
 *     toast.success({ title: 'Recording saved!' });
 *   }
 * }
 * ```
 *
 * @tip The imperative `.execute()` method is especially useful for:
 * - Event handlers that need to await the result
 * - Sequential operations that depend on each other
 * - Non-component code that needs to trigger mutations
 */
export function defineMutation<TData, TError, TVariables, TContext>(
	options: Omit<
		MutationOptions<TData, TError, TVariables, TContext>,
		'mutationFn'
	> & {
		mutationKey: MutationKey;
		resultMutationFn: MutationFunction<Result<TData, TError>, TVariables>;
	},
) {
	const newOptions = {
		...options,
		mutationFn: async (variables: TVariables) => {
			return resolve(await options.resultMutationFn(variables));
		},
	} satisfies MutationOptions<TData, TError, TVariables, TContext>;

	return {
		/**
		 * Returns the mutation options for reactive usage with TanStack Query hooks.
		 * Use this with `createMutation()` in Svelte components for reactive mutation state.
		 * @returns The mutation options object configured for TanStack Query
		 */
		options: () => newOptions,
		/**
		 * Bypasses the reactive mutation hooks and executes the mutation imperatively.
		 *
		 * This is the recommended way to trigger mutations from:
		 * - Button click handlers
		 * - Form submissions
		 * - Keyboard shortcuts
		 * - Any non-component code
		 *
		 * The method automatically wraps the result in a Result type, so you always
		 * get back `{ data, error }` for consistent error handling.
		 *
		 * @param variables - The variables to pass to the mutation function
		 * @returns Promise that resolves with a Result containing either the data or an error
		 *
		 * @example
		 * // In an event handler
		 * async function handleSubmit(formData: FormData) {
		 *   const { data, error } = await createUser.execute(formData);
		 *   if (error) {
		 *     toast.error({ title: 'Failed to create user', description: error.message });
		 *     return;
		 *   }
		 *   goto(`/users/${data.id}`);
		 * }
		 */
		async execute(variables: TVariables) {
			try {
				return Ok(await executeMutation(newOptions, variables));
			} catch (error) {
				return Err(error as TError);
			}
		},
	};
}

/**
 * Internal helper that executes a mutation directly using the query client's mutation cache.
 *
 * This is what powers the `.execute()` method on mutations. It bypasses the reactive
 * mutation hooks and runs the mutation imperatively, which is perfect for event handlers
 * and other imperative code.
 *
 * @internal
 * @template TData - The type of data returned by the mutation
 * @template TError - The type of error that can be thrown
 * @template TVariables - The type of variables passed to the mutation
 * @template TContext - The type of context data
 * @param options - The mutation options including mutationFn and mutationKey
 * @param variables - The variables to pass to the mutation function
 * @returns Promise that resolves with the mutation result
 */
function executeMutation<TData, TError, TVariables, TContext>(
	options: MutationOptions<TData, TError, TVariables, TContext>,
	variables: TVariables,
) {
	const mutation = queryClient.getMutationCache().build(queryClient, options);
	return mutation.execute(variables);
}

/**
 * Ensures only one recording mode is active at a time by stopping all other modes.
 * This prevents conflicts between different recording methods and ensures clean transitions.
 *
 * @param modeToKeep - The recording mode that should remain active (all others will be stopped)
 * @returns Promise that resolves when all other recording modes have been stopped
 *
 * @example
 * // Before starting manual recording, stop any other active recording modes
 * await stopAllRecordingModesExcept('manual');
 *
 * // Before starting VAD, ensure manual recording is stopped
 * await stopAllRecordingModesExcept('vad');
 */
export async function stopAllRecordingModesExcept(
	modeToKeep: RecordingMode,
): Promise<void> {
	const services = await import('$lib/services');

	// Each recording mode with its check and stop logic
	const recordingModes = [
		{
			mode: 'vad' as const,
			isActive: () => services.vad.getVadState() !== 'IDLE',
			stop: () => services.vad.stopActiveListening(),
		},
		{
			mode: 'manual' as const,
			isActive: () =>
				services.manualRecorder.getRecorderState().data === 'RECORDING',
			stop: () =>
				services.manualRecorder.stopRecording({
					sendStatus: () => {}, // Silent cancel - no UI notifications
				}),
		},
	] satisfies {
		mode: RecordingMode;
		isActive: () => boolean;
		stop: () => Promise<unknown>;
	}[];

	// Stop all modes except the one to keep
	for (const recordingMode of recordingModes) {
		if (recordingMode.mode === modeToKeep) continue;

		if (recordingMode.isActive()) {
			await recordingMode.stop();
		}
	}
}
