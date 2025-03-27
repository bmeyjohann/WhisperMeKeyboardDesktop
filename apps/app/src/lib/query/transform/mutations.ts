import { createResultMutation, playSoundIfEnabled } from '$lib/services';
import { RunTransformationService } from '$lib/services/index.js';
import { TransformErrorToWhisperingErr } from '$lib/services/runTransformation';
import { toast } from '$lib/services/toast';
import { settings } from '$lib/stores/settings.svelte';
import { Ok } from '@epicenterhq/result';
import { WhisperingErr, type WhisperingResult } from '@repo/shared';
import { queryClient } from '..';
import { maybeCopyAndPaste } from '../singletons/maybeCopyAndPaste';
import { transformationRunKeys } from '../transformationRuns/queries';
import { transformationsKeys } from '../transformations/queries';

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
				const transformationRunResult =
					await RunTransformationService.transformInput({
						input,
						transformationId,
					});

				if (!transformationRunResult.ok) {
					return TransformErrorToWhisperingErr(transformationRunResult);
				}

				const transformationRun = transformationRunResult.data;

				if (transformationRun.error) {
					return WhisperingErr({
						title: '⚠️ Transformation failed',
						description: transformationRun.error,
						action: { type: 'more-details', error: transformationRun.error },
					});
				}

				if (!transformationRun.output) {
					return WhisperingErr({
						title: '⚠️ Transformation produced no output',
						description: 'The transformation completed but produced no output.',
					});
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
				const transformationRunResult =
					await RunTransformationService.transformClipboard({
						transformationId,
					});

				if (!transformationRunResult.ok) {
					return TransformErrorToWhisperingErr(transformationRunResult);
				}

				const transformationRun = transformationRunResult.data;

				if (transformationRun.error) {
					return WhisperingErr({
						title: '⚠️ Transformation failed',
						description: transformationRun.error,
						action: { type: 'more-details', error: transformationRun.error },
					});
				}

				if (!transformationRun.output) {
					return WhisperingErr({
						title: '⚠️ Transformation produced no output',
						description: 'The transformation completed but produced no output.',
					});
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
				const transformationResult =
					await RunTransformationService.transformRecording({
						transformationId,
						recordingId,
					});

				if (!transformationResult.ok) {
					return WhisperingErr({
						title: '⚠️ Transformation failed',
						description:
							'Failed to apply the transformation on the recording..',
						action: {
							type: 'more-details',
							error: transformationResult.error,
						},
					});
				}

				const transformationRun = transformationResult.data;
				if (transformationRun.error) {
					return WhisperingErr({
						title: '⚠️ Transformation error',
						description: 'Failed to apply the transformation on the recording.',
						action: {
							type: 'more-details',
							error: transformationRun.error,
						},
					});
				}

				if (!transformationRun.output) {
					return WhisperingErr({
						title: '⚠️ Transformation produced no output',
						description: 'The transformation completed but produced no output.',
					});
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
