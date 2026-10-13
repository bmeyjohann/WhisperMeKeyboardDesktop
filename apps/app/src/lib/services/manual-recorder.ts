// import { extension } from '@repo/extension';
import {
	TIMESLICE_MS,
	type DevRecordingInputMode,
	type CancelRecordingResult,
	type WhisperMeRecordingState,
} from '$lib/constants/audio';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import type { TaggedError } from 'wellcrafted/error';
import {
	getRecordingStream,
	cleanupRecordingStream,
	enumerateRecordingDevices,
	type UpdateStatusMessageFn,
	type DeviceAcquisitionOutcome,
} from './device-stream';

type RecordingServiceError = TaggedError<'RecordingServiceError'>;

type RealActiveRecording = {
	kind: 'real';
	selectedDeviceId: string | null;
	bitrateKbps: string;
	stream: MediaStream;
	mediaRecorder: MediaRecorder;
	recordedChunks: Blob[];
};

type MockActiveRecording = {
	kind: 'mock';
	selectedDeviceId: string | null;
	bitrateKbps: string;
	devInputMode: Exclude<DevRecordingInputMode, 'microphone'>;
	devSampleAudioUrl: string;
};

type ActiveRecording = RealActiveRecording | MockActiveRecording;

export function createManualRecorderService() {
	let activeRecording: ActiveRecording | null = null;

	return {
		getRecorderState: (): Result<
			WhisperMeRecordingState,
			RecordingServiceError
		> => {
			return Ok(activeRecording ? 'RECORDING' : 'IDLE');
		},

		enumerateRecordingDevices,

		startRecording: async (
			{
				selectedDeviceId,
				bitrateKbps,
				devInputMode,
				devSampleAudioUrl,
			}: {
				selectedDeviceId: string | null;
				bitrateKbps: string;
				devInputMode: DevRecordingInputMode;
				devSampleAudioUrl: string;
			},
			{ sendStatus }: { sendStatus: UpdateStatusMessageFn },
		): Promise<Result<DeviceAcquisitionOutcome, RecordingServiceError>> => {
			// Ensure we're not already recording
			if (activeRecording) {
				return Err({
					name: 'RecordingServiceError',
					message:
						'A recording is already in progress. Please stop the current recording before starting a new one.',
					context: { activeRecording },
					cause: undefined,
				});
			}

			if (devInputMode !== 'microphone') {
				sendStatus({
					title:
						devInputMode === 'sample'
							? '🧪 Dev sample mode active'
							: '🧪 Dev recording disabled',
					description:
						devInputMode === 'sample'
							? 'Microphone capture is bypassed. WhisperMe will use sample audio when you stop.'
							: 'Microphone capture is bypassed. WhisperMe will use a generated synthetic sample when you stop.',
				});
				activeRecording = {
					kind: 'mock',
					selectedDeviceId,
					bitrateKbps,
					devInputMode,
					devSampleAudioUrl,
				};
				return Ok({ outcome: 'success' });
			}

			sendStatus({
				title: '🎙️ Starting Recording',
				description: 'Setting up your microphone...',
			});

			// Get the recording stream
			const { data: streamResult, error: acquireStreamError } =
				await getRecordingStream(selectedDeviceId, sendStatus);
			if (acquireStreamError) return Err(acquireStreamError);

			const { stream, deviceOutcome } = streamResult;

			const { data: mediaRecorder, error: recorderError } = trySync({
				try: () =>
					new MediaRecorder(stream, {
						bitsPerSecond: Number(bitrateKbps) * 1000,
					}),
				mapError: (error): RecordingServiceError => ({
					name: 'RecordingServiceError',
					message:
						'Failed to initialize the audio recorder. This could be due to unsupported audio settings, microphone conflicts, or browser limitations. Please check your microphone is working and try adjusting your audio settings.',
					context: { selectedDeviceId, bitrateKbps },
					cause: error,
				}),
			});

			if (recorderError) {
				// Clean up stream if recorder creation fails
				cleanupRecordingStream(stream);
				return Err(recorderError);
			}

			// Set up recording state and event handlers
			const recordedChunks: Blob[] = [];

			// Store active recording state
			activeRecording = {
				kind: 'real',
				selectedDeviceId,
				bitrateKbps,
				stream,
				mediaRecorder,
				recordedChunks,
			};

			// Set up event handlers
			mediaRecorder.addEventListener('dataavailable', (event: BlobEvent) => {
				if (event.data.size) recordedChunks.push(event.data);
			});

			// Start recording
			mediaRecorder.start(TIMESLICE_MS);

			// Return the device acquisition outcome
			return Ok(deviceOutcome);
		},

		stopRecording: async ({
			sendStatus,
		}: {
			sendStatus: UpdateStatusMessageFn;
		}): Promise<Result<Blob, RecordingServiceError>> => {
			if (!activeRecording) {
				return Err({
					name: 'RecordingServiceError',
					message:
						'Cannot stop recording because no active recording session was found. Make sure you have started recording before attempting to stop it.',
					context: { activeRecording },
					cause: undefined,
				});
			}

			const recording = activeRecording;
			activeRecording = null; // Clear immediately to prevent race conditions

			if (recording.kind === 'mock') {
				sendStatus({
					title: '🧪 Generating Dev Audio',
					description:
						recording.devInputMode === 'sample'
							? 'Loading sample audio for transcription...'
							: 'Generating synthetic audio sample...',
				});
				const { data: blob, error: mockBlobError } =
					recording.devInputMode === 'sample'
						? await getSampleAudioBlob(recording.devSampleAudioUrl)
						: createGeneratedDevAudioBlob();
				if (mockBlobError) return Err(mockBlobError);

				sendStatus({
					title: '✅ Dev Sample Ready',
					description: 'Using non-microphone audio for this recording.',
				});
				return Ok(blob);
			}

			sendStatus({
				title: '⏸️ Finishing Recording',
				description: 'Saving your audio...',
			});

			// Stop the recorder and wait for the final data
			const { data: blob, error: stopError } = await tryAsync({
				try: () =>
					new Promise<Blob>((resolve) => {
						recording.mediaRecorder.addEventListener('stop', () => {
							const audioBlob = new Blob(recording.recordedChunks, {
								type: recording.mediaRecorder.mimeType,
							});
							resolve(audioBlob);
						});
						recording.mediaRecorder.stop();
					}),
				mapError: (error): RecordingServiceError => ({
					name: 'RecordingServiceError',
					message:
						'Failed to properly stop and save the recording. This might be due to corrupted audio data, insufficient storage space, or a browser issue. Your recording data may be lost.',
					context: {
						chunksCount: recording.recordedChunks.length,
						mimeType: recording.mediaRecorder.mimeType,
						state: recording.mediaRecorder.state,
					},
					cause: error,
				}),
			});

			// Always clean up the stream
			cleanupRecordingStream(recording.stream);

			if (stopError) return Err(stopError);

			sendStatus({
				title: '✅ Recording Saved',
				description: 'Your recording is ready for transcription!',
			});
			return Ok(blob);
		},

		cancelRecording: async ({
			sendStatus,
		}: {
			sendStatus: UpdateStatusMessageFn;
		}): Promise<Result<CancelRecordingResult, RecordingServiceError>> => {
			if (!activeRecording) {
				return Ok({ status: 'no-recording' });
			}

			const recording = activeRecording;
			activeRecording = null; // Clear immediately

			sendStatus({
				title: '🛑 Cancelling',
				description: 'Discarding your recording...',
			});

			// Stop the recorder
			if (recording.kind === 'real') {
				recording.mediaRecorder.stop();

				// Clean up the stream
				cleanupRecordingStream(recording.stream);
			}

			sendStatus({
				title: '✨ Cancelled',
				description: 'Recording discarded successfully!',
			});

			return Ok({ status: 'cancelled' });
		},
	};
}

export const NavigatorRecorderServiceLive = createManualRecorderService();

function createGeneratedDevAudioBlob(): Result<Blob, RecordingServiceError> {
	const durationSeconds = 1.5;
	const sampleRate = 16000;
	const channels = 1;
	const frequencyHz = 440;
	const frameCount = Math.floor(sampleRate * durationSeconds);
	const dataSize = frameCount * channels * 2;
	const headerSize = 44;
	const buffer = new ArrayBuffer(headerSize + dataSize);
	const view = new DataView(buffer);

	writeAscii(view, 0, 'RIFF');
	view.setUint32(4, 36 + dataSize, true);
	writeAscii(view, 8, 'WAVE');
	writeAscii(view, 12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	writeAscii(view, 36, 'data');
	view.setUint32(40, dataSize, true);

	for (let i = 0; i < frameCount; i++) {
		const sample = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate);
		const amplitude = 0.18 * sample;
		view.setInt16(headerSize + i * 2, Math.floor(amplitude * 0x7fff), true);
	}

	return Ok(new Blob([buffer], { type: 'audio/wav' }));
}

async function getSampleAudioBlob(
	sampleAudioUrl: string,
): Promise<Result<Blob, RecordingServiceError>> {
	if (!sampleAudioUrl.trim()) {
		return createGeneratedDevAudioBlob();
	}

	return tryAsync({
		try: async () => {
			const response = await fetch(sampleAudioUrl);
			if (!response.ok) {
				throw new Error(
					`Sample audio request failed with status ${response.status}`,
				);
			}
			const blob = await response.blob();
			if (blob.size === 0) {
				throw new Error('Sample audio file is empty');
			}
			return blob;
		},
		mapError: (error): RecordingServiceError => ({
			name: 'RecordingServiceError',
			message:
				'Failed to load sample audio URL for dev recording mode. Falling back to generated synthetic audio.',
			context: { sampleAudioUrl },
			cause: error,
		}),
	}).then((result) => {
		if (!result.error) return result;
		return createGeneratedDevAudioBlob();
	});
}

function writeAscii(view: DataView, offset: number, value: string) {
	for (let i = 0; i < value.length; i++) {
		view.setUint8(offset + i, value.charCodeAt(i));
	}
}
