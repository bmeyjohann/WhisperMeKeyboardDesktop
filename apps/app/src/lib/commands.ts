import { createTapHoldShortcut } from './services/tap-hold-shortcut';
import { usesRealtimeVoice, isVoiceSessionActive, toggleRealtimeVoice, cancelRealtimeVoice } from './services/realtime-voice';
import { rpc } from '$lib/query';
import { settings } from '$lib/stores/settings.svelte';
import { toast } from '$lib/toast';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { nanoid } from 'nanoid/non-secure';
import {
	deliverTranscribedText,
	deliverTransformedText,
} from './deliverTextToUser';
import type { ShortcutTriggerState } from './services/_shortcut-trigger-state';
import { auth0Service } from './services/auth0';

async function sessionReadyForRecording() {
    if (settings.value['transcription.selectedTranscriptionService'] !== 'WhisperMe') return true;
    if (await auth0Service.getVoiceAccessToken()) return true;
    toast.error({ id: nanoid(), title: 'Sign-in check required', description: 'Open WhisperMe and sign in or retry the session check before recording. No audio was recorded.' });
    return false;
}

type OverlayDisplayState = 'recording' | 'processing' | 'hidden';

const overlayCommandByState = {
	recording: 'show_recording_overlay',
	processing: 'show_processing_overlay',
	hidden: 'hide_recording_overlay',
} as const satisfies Record<OverlayDisplayState, string>;

function shouldRenderRecordingOverlay() {
	return (
		typeof window !== 'undefined' &&
		Boolean(window.__TAURI_INTERNALS__) &&
		settings.value['overlay.enabled']
	);
}

async function setRecordingOverlayState(state: OverlayDisplayState) {
	if (!shouldRenderRecordingOverlay()) return;

	try {
		await tauriInvoke(overlayCommandByState[state]);
	} catch (error) {
		console.warn(`Failed to set recording overlay state to ${state}`, error);
	}
}

const stopManualRecording = async () => {
	const toastId = nanoid();
	toast.loading({
		id: toastId,
		title: '⏸️ Stopping recording...',
		description: 'Finalizing your audio capture...',
	});
	const { data: blob, error: stopRecordingError } =
		await rpc.manualRecorder.stopRecording.execute({ toastId });
	if (stopRecordingError) {
		toast.error({
			id: toastId,
			title: '❌ Failed to stop recording',
			description: 'Your recording could not be stopped. Please try again.',
			action: { type: 'more-details', error: stopRecordingError },
		});
		await setRecordingOverlayState('hidden');
		return;
	}

	toast.success({
		id: toastId,
		title: '🎙️ Recording stopped',
		description: 'Your recording has been saved',
	});
	console.info('Recording stopped');
	rpc.sound.playSoundIfEnabled.execute('manual-stop');
	await setRecordingOverlayState('processing');

	await saveRecordingAndTranscribeTransform({
		blob,
		toastId,
		completionTitle: '✨ Recording Complete!',
		completionDescription: 'Recording saved and session closed successfully',
	});
};

const startManualRecording = async () => {
    if (!(await sessionReadyForRecording())) return;
	const toastId = nanoid();
	toast.loading({
		id: toastId,
		title: '🎙️ Preparing to record...',
		description: 'Setting up your recording environment...',
	});

	const { data: deviceAcquisitionOutcome, error: startRecordingError } =
		await rpc.manualRecorder.startRecording.execute({
			toastId,
		});

	if (startRecordingError) {
		toast.error({
			id: toastId,
			title: '❌ Failed to start recording',
			description: 'Your recording could not be started. Please try again.',
			action: { type: 'more-details', error: startRecordingError },
		});
		await setRecordingOverlayState('hidden');
		return;
	}

	switch (deviceAcquisitionOutcome.outcome) {
		case 'success': {
			toast.success({
				id: toastId,
				title: '🎙️ WhisperMe is recording...',
				description: 'Speak now and stop recording when done',
			});
			break;
		}
		case 'fallback': {
			settings.value = {
				...settings.value,
				'recording.navigator.selectedDeviceId':
					deviceAcquisitionOutcome.fallbackDeviceId,
			};
			switch (deviceAcquisitionOutcome.reason) {
				case 'no-device-selected': {
					toast.info({
						id: toastId,
						title: '🎙️ Switched to available microphone',
						description:
							'No microphone was selected, so we automatically connected to an available one. You can update your selection in settings.',
						action: {
							type: 'link',
							label: 'Open Settings',
							goto: '/settings/recording',
						},
					});
					break;
				}
				case 'preferred-device-unavailable': {
					toast.info({
						id: toastId,
						title: '🎙️ Switched to different microphone',
						description:
							"Your previously selected microphone wasn't found, so we automatically connected to an available one.",
						action: {
							type: 'link',
							label: 'Open Settings',
							goto: '/settings/recording',
						},
					});
					break;
				}
			}
		}
	}
	console.info('Recording started');
	rpc.sound.playSoundIfEnabled.execute('manual-start');
	await setRecordingOverlayState('recording');
};

const stopCpalRecording = async () => {
	const toastId = nanoid();
	toast.loading({
		id: toastId,
		title: '⏸️ Stopping CPAL recording...',
		description: 'Finalizing your audio capture...',
	});
	const { data: blob, error: stopRecordingError } =
		await rpc.cpalRecorder.stopRecording.execute({ toastId });
	if (stopRecordingError) {
		toast.error({
			id: toastId,
			title: '❌ Failed to stop CPAL recording',
			description: 'Your recording could not be stopped. Please try again.',
			action: { type: 'more-details', error: stopRecordingError },
		});
		await setRecordingOverlayState('hidden');
		return;
	}

	toast.success({
		id: toastId,
		title: '🔊 CPAL Recording stopped',
		description: 'Your recording has been saved',
	});
	console.info('CPAL Recording stopped');
	rpc.sound.playSoundIfEnabled.execute('cpal-stop');
	await setRecordingOverlayState('processing');

	await saveRecordingAndTranscribeTransform({
		blob,
		toastId,
		completionTitle: '✨ CPAL Recording Complete!',
		completionDescription: 'Recording saved and session closed successfully',
	});
};

const startCpalRecording = async () => {
    if (!(await sessionReadyForRecording())) return;
	const toastId = nanoid();
	toast.loading({
		id: toastId,
		title: '🔊 Preparing CPAL recording...',
		description: 'Setting up native audio recording...',
	});

	const { error: startRecordingError } =
		await rpc.cpalRecorder.startRecording.execute({
			toastId,
			selectedDeviceId: settings.value['recording.cpal.selectedDeviceId'],
		});

	if (startRecordingError) {
		toast.error({
			id: toastId,
			title: '❌ Failed to start CPAL recording',
			description: 'Your recording could not be started. Please try again.',
			action: { type: 'more-details', error: startRecordingError },
		});
		await setRecordingOverlayState('hidden');
		return;
	}

	toast.success({
		id: toastId,
		title: '🔊 CPAL is recording...',
		description: 'Speak now and stop recording when done',
	});
	console.info('CPAL Recording started');
	rpc.sound.playSoundIfEnabled.execute('cpal-start');
	await setRecordingOverlayState('recording');
};

type SatisfiedCommand = {
	id: string;
	title: string;
	on: ShortcutTriggerState;
	callback: (state?: 'Pressed' | 'Released' | MouseEvent) => void;
};

// Realtime reserves its phase synchronously; do not wait for provider startup before
// accepting a release. Batch capture serializes its asynchronous microphone startup.
const recordingShortcut = createTapHoldShortcut(async () => {
    if (usesRealtimeVoice()) {
        const started = !isVoiceSessionActive();
        void toggleRealtimeVoice();
        return started;
    }
    const {data, error} = await rpc.manualRecorder.getRecorderState.fetchCached();
    if (error) return false;
    if (data === 'RECORDING') { await stopManualRecording(); return false; }
    await startManualRecording();
    const state = await rpc.manualRecorder.getRecorderState.fetchCached();
    return !state.error && state.data === 'RECORDING';
}, async () => {
    if (usesRealtimeVoice()) { if (isVoiceSessionActive()) await toggleRealtimeVoice(); return; }
    const {data, error} = await rpc.manualRecorder.getRecorderState.fetchCached();
    if (!error && data === 'RECORDING') await stopManualRecording();
});

export const commands = [
	{
		id: 'pushToTalk',
		title: 'Push to talk',
		on: 'Both',
		callback: async () => {
			if (usesRealtimeVoice()) return toggleRealtimeVoice();
			const { data: recorderState, error: getRecorderStateError } =
				await rpc.manualRecorder.getRecorderState.fetchCached();
			if (getRecorderStateError) {
				toast.error({
					id: nanoid(),
					title: '❌ Failed to get recorder state',
					description: 'Your recording could not be started. Please try again.',
					action: { type: 'more-details', error: getRecorderStateError },
				});
				return;
			}
			if (recorderState === 'RECORDING') {
				await stopManualRecording();
			} else {
				await startManualRecording();
			}
		},
	},
	{
		id: 'toggleManualRecording',
		title: 'Record (tap or hold)',
		on: 'Both',
		callback: async (state?: 'Pressed' | 'Released' | MouseEvent) => {
            if (state === 'Pressed' || state === 'Released') { recordingShortcut(state); return; }
			if (usesRealtimeVoice()) return toggleRealtimeVoice();
			const { data: recorderState, error: getRecorderStateError } =
				await rpc.manualRecorder.getRecorderState.fetchCached();
			if (getRecorderStateError) {
				toast.error({
					id: nanoid(),
					title: '❌ Failed to get recorder state',
					description: 'Your recording could not be started. Please try again.',
					action: { type: 'more-details', error: getRecorderStateError },
				});
				return;
			}
			if (recorderState === 'RECORDING') {
				await stopManualRecording();
			} else {
				await startManualRecording();
			}
		},
	},
	{
		id: 'cancelManualRecording',
		title: 'Cancel recording',
		on: 'Pressed',
		callback: async () => {
			if (usesRealtimeVoice()) return cancelRealtimeVoice();
			const toastId = nanoid();
			toast.loading({
				id: toastId,
				title: '⏸️ Canceling recording...',
				description: 'Cleaning up recording session...',
			});
			const { data: cancelRecordingResult, error: cancelRecordingError } =
				await rpc.manualRecorder.cancelRecording.execute({ toastId });
			if (cancelRecordingError) {
				toast.error({
					id: toastId,
					title: '❌ Failed to cancel recording',
					description:
						'Your recording could not be cancelled. Please try again.',
					action: { type: 'more-details', error: cancelRecordingError },
				});
				return;
			}
			switch (cancelRecordingResult.status) {
				case 'no-recording': {
					toast.info({
						id: toastId,
						title: 'No active recording',
						description: 'There is no recording in progress to cancel.',
					});
					await setRecordingOverlayState('hidden');
					break;
				}
				case 'cancelled': {
					// Session cleanup is now handled internally by the recorder service
					toast.success({
						id: toastId,
						title: '✅ All Done!',
						description: 'Recording cancelled successfully',
					});
					rpc.sound.playSoundIfEnabled.execute('manual-cancel');
					console.info('Recording cancelled');
					await setRecordingOverlayState('hidden');
					break;
				}
			}
		},
	},
	{
		id: 'toggleVadRecording',
		title: 'Toggle voice activated recording',
		on: 'Pressed',
		callback: async () => {
			if (usesRealtimeVoice()) return toggleRealtimeVoice();
			const { data: vadState } =
				await rpc.vadRecorder.getVadState.fetchCached();
			if (vadState === 'LISTENING' || vadState === 'SPEECH_DETECTED') {
				const toastId = nanoid();
				console.info('Stopping voice activated capture');
				toast.loading({
					id: toastId,
					title: '⏸️ Stopping voice activated capture...',
					description: 'Finalizing your voice activated capture...',
				});
				const { error: stopVadError } =
					await rpc.vadRecorder.stopActiveListening.execute(undefined);
				if (stopVadError) {
					toast.error({ id: toastId, ...stopVadError });
					return;
				}
				toast.success({
					id: toastId,
					title: '🎙️ Voice activated capture stopped',
					description: 'Your voice activated capture has been stopped.',
				});
				rpc.sound.playSoundIfEnabled.execute('vad-stop');
				return;
			}
			const toastId = nanoid();
			if (!(await sessionReadyForRecording())) return;
			console.info('Starting voice activated capture');
			toast.loading({
				id: toastId,
				title: '🎙️ Starting voice activated capture',
				description: 'Your voice activated capture is starting...',
			});

			const {
				data: deviceAcquisitionOutcome,
				error: startActiveListeningError,
			} = await rpc.vadRecorder.startActiveListening.execute({
				onSpeechStart: () => {
					toast.success({
						title: '🎙️ Speech started',
						description: 'Recording started. Speak clearly and loudly.',
					});
				},
				onSpeechEnd: async (blob) => {
					const toastId = nanoid();
					toast.success({
						id: toastId,
						title: '🎙️ Voice activated speech captured',
						description: 'Your voice activated speech has been captured.',
					});
					console.info('Voice activated speech captured');
					rpc.sound.playSoundIfEnabled.execute('vad-capture');

					await saveRecordingAndTranscribeTransform({
						blob,
						toastId,
						completionTitle: '✨ Voice activated capture complete!',
						completionDescription:
							'Voice activated capture complete! Ready for another take',
					});
				},
			});
			if (startActiveListeningError) {
				toast.error({ id: toastId, ...startActiveListeningError });
				return;
			}

			// Handle device acquisition outcome
			switch (deviceAcquisitionOutcome.outcome) {
				case 'success': {
					toast.success({
						id: toastId,
						title: '🎙️ Voice activated capture started',
						description: 'Your voice activated capture has been started.',
					});
					break;
				}
				case 'fallback': {
					settings.value = {
						...settings.value,
						'recording.navigator.selectedDeviceId':
							deviceAcquisitionOutcome.fallbackDeviceId,
					};
					switch (deviceAcquisitionOutcome.reason) {
						case 'no-device-selected': {
							toast.info({
								id: toastId,
								title: '🎙️ VAD started with available microphone',
								description:
									'No microphone was selected for VAD, so we automatically connected to an available one. You can update your selection in settings.',
								action: {
									type: 'link',
									label: 'Open Settings',
									goto: '/settings/recording',
								},
							});
							break;
						}
						case 'preferred-device-unavailable': {
							toast.info({
								id: toastId,
								title: '🎙️ VAD switched to different microphone',
								description:
									"Your previously selected VAD microphone wasn't found, so we automatically connected to an available one.",
								action: {
									type: 'link',
									label: 'Open Settings',
									goto: '/settings/recording',
								},
							});
							break;
						}
					}
				}
			}

			rpc.sound.playSoundIfEnabled.execute('vad-start');
		},
	},
	...(window.__TAURI_INTERNALS__
		? ([
				{
					id: 'toggleCpalRecording',
					title: 'Toggle CPAL recording',
					on: 'Pressed',
					callback: async () => {
			if (usesRealtimeVoice()) return toggleRealtimeVoice();
						const { data: recorderState, error: getRecorderStateError } =
							await rpc.cpalRecorder.getRecorderState.fetchCached();
						if (getRecorderStateError) {
							toast.error({
								id: nanoid(),
								title: '❌ Failed to get CPAL recorder state',
								description:
									'Your recording could not be started. Please try again.',
								action: { type: 'more-details', error: getRecorderStateError },
							});
							return;
						}
						if (recorderState === 'RECORDING') {
							await stopCpalRecording();
						} else {
							await startCpalRecording();
						}
					},
				},
				{
					id: 'cancelCpalRecording',
					title: 'Cancel CPAL recording',
					on: 'Pressed',
					callback: async () => {
			if (usesRealtimeVoice()) return cancelRealtimeVoice();
						const toastId = nanoid();
						toast.loading({
							id: toastId,
							title: '⏸️ Canceling CPAL recording...',
							description: 'Cleaning up recording session...',
						});
						const { data: cancelRecordingResult, error: cancelRecordingError } =
							await rpc.cpalRecorder.cancelRecording.execute({ toastId });
						if (cancelRecordingError) {
							toast.error({
								id: toastId,
								title: '❌ Failed to cancel CPAL recording',
								description:
									'Your recording could not be cancelled. Please try again.',
								action: { type: 'more-details', error: cancelRecordingError },
							});
							return;
						}
						switch (cancelRecordingResult.status) {
							case 'no-recording': {
								toast.info({
									id: toastId,
									title: 'No active recording',
									description:
										'There is no CPAL recording in progress to cancel.',
								});
								await setRecordingOverlayState('hidden');
								break;
							}
							case 'cancelled': {
								toast.success({
									id: toastId,
									title: '✅ All Done!',
									description: 'CPAL recording cancelled successfully',
								});
								rpc.sound.playSoundIfEnabled.execute('cpal-cancel');
								console.info('CPAL Recording cancelled');
								await setRecordingOverlayState('hidden');
								break;
							}
						}
					},
				},
			] as const satisfies SatisfiedCommand[])
		: []),
] as const satisfies SatisfiedCommand[];

export type Command = (typeof commands)[number];

type CommandCallbacks = Record<Command['id'], Command['callback']>;

export const commandCallbacks = commands.reduce<CommandCallbacks>(
	(acc, command) => {
		acc[command.id] = command.callback;
		return acc;
	},
	{} as CommandCallbacks,
);

/**
 * Saves a recording blob to the database and immediately transcribes it.
 *
 * This function handles the complete flow from recording creation through transcription:
 * 1. Creates recording metadata and saves to database
 * 2. Handles database save errors
 * 3. Shows completion toast
 * 4. Executes transcription flow
 * 5. Applies transformation if one is selected
 *
 * @param blob - The audio blob to save
 * @param toastId - Toast ID for consistent notifications
 * @param completionTitle - Title for the completion toast
 * @param completionDescription - Description for the completion toast
 */
async function saveRecordingAndTranscribeTransform({
	blob,
	toastId,
	completionTitle,
	completionDescription,
}: {
	blob: Blob;
	toastId: string;
	completionTitle: string;
	completionDescription: string;
}) {
	const now = new Date().toISOString();
	const newRecordingId = nanoid();
	try {
		const { data: createdRecording, error: createRecordingError } =
			await rpc.recordings.createRecording.execute({
				id: newRecordingId,
				title: '',
				subtitle: '',
				createdAt: now,
				updatedAt: now,
				timestamp: now,
				transcribedText: '',
				blob,
				transcriptionStatus: 'UNPROCESSED',
			});

		if (createRecordingError) {
			toast.error({
				id: toastId,
				title: '❌ Failed to save recording',
				description:
					'Your recording was captured but could not be saved to the database. Please check your storage space and permissions.',
				action: { type: 'more-details', error: createRecordingError },
			});
			return;
		}

		toast.success({
			id: toastId,
			title: completionTitle,
			description: completionDescription,
		});

		const transcribeToastId = nanoid();
		toast.loading({
			id: transcribeToastId,
			title: '📋 Transcribing...',
			description: 'Your recording is being transcribed...',
		});

		const { data: transcribedText, error: transcribeError } =
			await rpc.transcription.transcribeRecording.execute(createdRecording);

		if (transcribeError) {
			if (transcribeError.name === 'WhisperMeError') {
				toast.error({ id: transcribeToastId, ...transcribeError });
				return;
			}
			toast.error({
				id: transcribeToastId,
				title: '❌ Failed to transcribe recording',
				description: 'Your recording could not be transcribed.',
				action: { type: 'more-details', error: transcribeError },
			});
			return;
		}

		rpc.sound.playSoundIfEnabled.execute('transcriptionComplete');

		await deliverTranscribedText({
			text: transcribedText,
			toastId: transcribeToastId,
		});
		// Notice-only voice controls return no text and must not feed automatic transformations.
		if (!transcribedText) return;

		// Determine if we need to chain to transformation
		const transformationId =
			settings.value['transformations.selectedTransformationId'];

		// Check if transformation is valid if specified
		if (!transformationId) return;
		const { data: transformation, error: getTransformationError } =
			await rpc.transformations.queries
				.getTransformationById(() => transformationId)
				.fetchCached();

		const couldNotRetrieveTransformation = getTransformationError;
		const transformationNoLongerExists = !transformation;

		if (couldNotRetrieveTransformation) {
			toast.error({
				id: nanoid(),
				title: '❌ Failed to get transformation',
				description:
					'Your transformation could not be retrieved. Please try again.',
				action: { type: 'more-details', error: getTransformationError },
			});
			return;
		}

		if (transformationNoLongerExists) {
			settings.value = {
				...settings.value,
				'transformations.selectedTransformationId': null,
			};
			toast.warning({
				id: nanoid(),
				title: '⚠️ No matching transformation found',
				description:
					'No matching transformation found. Please select a different transformation.',
				action: {
					type: 'link',
					label: 'Select a different transformation',
					goto: '/transformations',
				},
			});
			return;
		}

		const transformToastId = nanoid();
		toast.loading({
			id: transformToastId,
			title: '🔄 Running transformation...',
			description:
				'Applying your selected transformation to the transcribed text...',
		});
		const { data: transformationRun, error: transformError } =
			await rpc.transformer.transformRecording.execute({
				recordingId: createdRecording.id,
				transformation,
			});
		if (transformError) {
			toast.error({ id: transformToastId, ...transformError });
			return;
		}

		if (transformationRun.status === 'failed') {
			toast.error({
				id: transformToastId,
				title: '⚠️ Transformation error',
				description: transformationRun.error,
				action: { type: 'more-details', error: transformationRun.error },
			});
			return;
		}

		rpc.sound.playSoundIfEnabled.execute('transformationComplete');

		await deliverTransformedText({ text: transformationRun.output, toastId });
	} finally {
		await setRecordingOverlayState('hidden');
	}
}
