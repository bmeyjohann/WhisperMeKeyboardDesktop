import { createResultMutation, playSoundIfEnabled } from '$lib/services';
import { RunTransformationService } from '$lib/services/index.js';
import { toast } from '$lib/services/toast';
import { settings } from '$lib/stores/settings.svelte';
import { Err, Ok } from '@epicenterhq/result';
import { WhisperingError, type WhisperingResult } from '@repo/shared';
import { queryClient } from '..';
import { maybeCopyAndPaste } from '../singletons/maybeCopyAndPaste';
import { transformationRunKeys } from '../transformationRuns/queries';
import { transformationsKeys } from '../transformations/queries';
import { TransformErrorToWhisperingErr } from '$lib/services/runTransformation';

export function useTransformInput() {
	return {
		transformInput: createResultMutation(() => ({
			onMutate: ({ toastId }) => {
				toast.loading({
					id: toastId,
					title: '🔄 Running transformation...',
					description: 'Applying your selected transformation to the input...',
				});
			},
			mutationFn: async ({
				input,
				transformationId,
			}: {
				input: string;
				transformationId: string;
				toastId: string;
			}): Promise<WhisperingResult<string>> => {
				const { data: transformRun, error: transformInputError } =
					await RunTransformationService.transformInput({
						input,
						transformationId,
					});

				if (transformInputError) {
					return TransformErrorToWhisperingErr(Err(transformInputError));
				}

				if (transformRun.error) {
					return Err(
						WhisperingError({
							title: '⚠️ Transformation failed',
							description: transformRun.error,
							action: { type: 'more-details', error: transformRun.error },
						}),
					);
				}

				if (!transformRun.output) {
					return Err(
						WhisperingError({
							title: '⚠️ Transformation produced no output',
							description:
								'The transformation completed but produced no output.',
						}),
					);
				}

				return Ok(transformRun.output);
			},
			onError: (error, { toastId }) => {
				toast.error({ id: toastId, ...error });
			},
			onSuccess: (output, { toastId }) => {
				void playSoundIfEnabled('transformationComplete');
				maybeCopyAndPaste({
					text: output,
					toastId,
					shouldCopy: settings.value['transformation.clipboard.copyOnSuccess'],
					shouldPaste:
						settings.value['transformation.clipboard.pasteOnSuccess'],
					statusToToastText: (status) => {
						switch (status) {
							case null:
								return '🔄 Transformation complete!';
							case 'COPIED':
								return '🔄 Transformation complete and copied to clipboard!';
							case 'COPIED+PASTED':
								return '🔄 Transformation complete, copied to clipboard, and pasted!';
						}
					},
				});
			},
			onSettled: (_data, _error, { transformationId }) => {
				queryClient.invalidateQueries({
					queryKey:
						transformationRunKeys.runsByTransformationId(transformationId),
				});
				queryClient.invalidateQueries({
					queryKey: transformationsKeys.byId(transformationId),
				});
			},
		})),
	};
}

export function useTransformClipboard() {
	return {
		transformClipboard: createResultMutation(() => ({
			onMutate: ({ toastId }) => {
				toast.loading({
					id: toastId,
					title: '🔄 Running transformation...',
					description: 'Applying your selected transformation to the input...',
				});
			},
			mutationFn: async ({
				transformationId,
			}: {
				transformationId: string;
				toastId: string;
			}): Promise<WhisperingResult<string>> => {
				const { data: transformationRun, error: transformClipboardError } =
					await RunTransformationService.transformClipboard({
						transformationId,
					});

				if (transformClipboardError) {
					return TransformErrorToWhisperingErr(Err(transformClipboardError));
				}

				if (transformationRun.error) {
					return Err(
						WhisperingError({
							title: '⚠️ Transformation failed',
							description: transformationRun.error,
							action: { type: 'more-details', error: transformationRun.error },
						}),
					);
				}

				if (!transformationRun.output) {
					return Err(
						WhisperingError({
							title: '⚠️ Transformation produced no output',
							description:
								'The transformation completed but produced no output.',
						}),
					);
				}

				return Ok(transformationRun.output);
			},
			onError: (error, { toastId }) => {
				toast.error({ id: toastId, ...error });
			},
			onSuccess: (output, { toastId }) => {
				void playSoundIfEnabled('transformationComplete');
				maybeCopyAndPaste({
					text: output,
					toastId,
					shouldCopy: settings.value['transformation.clipboard.copyOnSuccess'],
					shouldPaste:
						settings.value['transformation.clipboard.pasteOnSuccess'],
					statusToToastText: (status) => {
						switch (status) {
							case null:
								return '🔄 Transformation complete!';
							case 'COPIED':
								return '🔄 Transformation complete and copied to clipboard!';
							case 'COPIED+PASTED':
								return '🔄 Transformation complete, copied to clipboard, and pasted!';
						}
					},
				});
			},
			onSettled: (_data, _error, { transformationId }) => {
				queryClient.invalidateQueries({
					queryKey:
						transformationRunKeys.runsByTransformationId(transformationId),
				});
				queryClient.invalidateQueries({
					queryKey: transformationsKeys.byId(transformationId),
				});
			},
		})),
	};
}

export function useTransformRecording() {
	return {
		transformRecording: createResultMutation(() => ({
			onMutate: ({ toastId }) => {
				toast.loading({
					id: toastId,
					title: '🔄 Running transformation...',
					description:
						'Applying your selected transformation to the transcribed text...',
				});
			},
			mutationFn: async ({
				recordingId,
				transformationId,
			}: {
				recordingId: string;
				transformationId: string;
				toastId: string;
			}): Promise<WhisperingResult<string>> => {
				const { data: transformationRun, error: transformRecordingError } =
					await RunTransformationService.transformRecording({
						transformationId,
						recordingId,
					});

				if (transformRecordingError) {
					return Err(
						WhisperingError({
							title: '⚠️ Transformation failed',
							description:
								'Failed to apply the transformation on the recording..',
							action: {
								type: 'more-details',
								error: transformRecordingError,
							},
						}),
					);
				}

				if (transformationRun.error) {
					return Err(
						WhisperingError({
							title: '⚠️ Transformation error',
							description:
								'Failed to apply the transformation on the recording.',
							action: {
								type: 'more-details',
								error: transformationRun.error,
							},
						}),
					);
				}

				if (!transformationRun.output) {
					return Err(
						WhisperingError({
							title: '⚠️ Transformation produced no output',
							description:
								'The transformation completed but produced no output.',
						}),
					);
				}

				return Ok(transformationRun.output);
			},
			onError: (error, { toastId }) => {
				toast.error({ id: toastId, ...error });
			},
			onSuccess: (output, { toastId }) => {
				void playSoundIfEnabled('transformationComplete');
				maybeCopyAndPaste({
					text: output,
					toastId,
					shouldCopy: settings.value['transformation.clipboard.copyOnSuccess'],
					shouldPaste:
						settings.value['transformation.clipboard.pasteOnSuccess'],
					statusToToastText: (status) => {
						switch (status) {
							case null:
								return '🔄 Transformation complete!';
							case 'COPIED':
								return '🔄 Transformation complete and copied to clipboard!';
							case 'COPIED+PASTED':
								return '🔄 Transformation complete, copied to clipboard, and pasted!';
						}
					},
				});
			},
			onSettled: (_data, _error, { recordingId, transformationId }) => {
				queryClient.invalidateQueries({
					queryKey: transformationRunKeys.runsByRecordingId(recordingId),
				});
				queryClient.invalidateQueries({
					queryKey:
						transformationRunKeys.runsByTransformationId(transformationId),
				});
				queryClient.invalidateQueries({
					queryKey: transformationsKeys.byId(transformationId),
				});
			},
		})),
	};
}
