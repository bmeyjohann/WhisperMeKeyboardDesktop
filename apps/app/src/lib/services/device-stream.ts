import { WHISPER_RECOMMENDED_MEDIA_TRACK_CONSTRAINTS } from '$lib/constants/audio';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { TaggedError } from 'wellcrafted/error';

type RecordingServiceError = TaggedError<'RecordingServiceError'>;

export type DeviceAcquisitionOutcome =
	| {
			outcome: 'success';
	  }
	| {
			outcome: 'fallback';
			reason: 'no-device-selected' | 'preferred-device-unavailable';
			fallbackDeviceId: string;
	  };

export type UpdateStatusMessageFn = (args: {
	title: string;
	description: string;
}) => void;

function getBrowserAudioDiagnostics() {
	return {
		isSecureContext:
			typeof window !== 'undefined' ? window.isSecureContext : false,
		protocol: typeof location !== 'undefined' ? location.protocol : 'unknown',
		hasMediaDevicesApi:
			typeof navigator !== 'undefined' && !!navigator.mediaDevices,
		hasGetUserMedia:
			typeof navigator !== 'undefined' &&
			typeof navigator.mediaDevices?.getUserMedia === 'function',
	};
}

function getErrorDetails(error: unknown) {
	if (error instanceof Error) {
		return {
			errorName: error.name,
			errorMessage: error.message,
		};
	}
	if (typeof error === 'string') {
		return {
			errorName: 'Error',
			errorMessage: error,
		};
	}
	return {
		errorName: 'UnknownError',
		errorMessage: String(error),
	};
}

async function requestAudioStream(
	audio: MediaTrackConstraints | true,
): Promise<MediaStream> {
	const mediaDevices = navigator.mediaDevices;
	if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
		const diagnostics = getBrowserAudioDiagnostics();
		throw new Error(
			`MediaDevices API unavailable (secureContext=${diagnostics.isSecureContext}, protocol=${diagnostics.protocol})`,
		);
	}

	return mediaDevices.getUserMedia({ audio });
}

async function requestAudioStreamWithFallback(): Promise<MediaStream> {
	try {
		return await requestAudioStream(
			WHISPER_RECOMMENDED_MEDIA_TRACK_CONSTRAINTS,
		);
	} catch (error) {
		const { errorName } = getErrorDetails(error);
		if (errorName === 'OverconstrainedError' || errorName === 'NotFoundError') {
			return requestAudioStream(true);
		}
		throw error;
	}
}

export async function hasExistingAudioPermission(): Promise<boolean> {
	try {
		const permissions = await navigator.permissions.query({
			name: 'microphone' as PermissionName,
		});
		return permissions.state === 'granted';
	} catch {
		try {
			const stream = await requestAudioStreamWithFallback();
			for (const track of stream.getTracks()) {
				track.stop();
			}
			return true;
		} catch {
			return false;
		}
	}
}

export async function enumerateRecordingDevices(): Promise<
	Result<MediaDeviceInfo[], RecordingServiceError>
> {
	const hasPermission = await hasExistingAudioPermission();
	if (!hasPermission) {
		// extension.openWhisperMeTab({});
	}
	return tryAsync({
		try: async () => {
			const devices = await navigator.mediaDevices.enumerateDevices();
			const audioInputDevices = devices.filter(
				(device) => device.kind === 'audioinput',
			);
			const hasUsableDeviceIds = audioInputDevices.some(
				(device) => device.deviceId.trim() !== '',
			);
			if (audioInputDevices.length > 0 && hasUsableDeviceIds) {
				return audioInputDevices;
			}

			const allAudioDevicesStream = await requestAudioStreamWithFallback();
			const devicesWithPermission =
				await navigator.mediaDevices.enumerateDevices();
			for (const track of allAudioDevicesStream.getTracks()) {
				track.stop();
			}
			const audioInputDevicesWithPermission = devicesWithPermission.filter(
				(device) => device.kind === 'audioinput',
			);
			return audioInputDevicesWithPermission;
		},
		mapError: (error) => ({
			name: 'RecordingServiceError',
			message:
				'Unable to access microphones. If another app is currently using your mic (exclusive mode), close it and try again.',
			context: {
				permissionRequired: 'microphone',
				...getErrorDetails(error),
				...getBrowserAudioDiagnostics(),
			},
			cause: error,
		}),
	});
}

export async function getStreamForDeviceId(recordingDeviceId: string) {
	const hasPermission = await hasExistingAudioPermission();
	if (!hasPermission) {
		// extension.openWhisperMeTab({});
	}
	return tryAsync({
		try: async () => {
			if (recordingDeviceId.trim() === '') {
				// Browsers/WebViews can return placeholder devices with empty IDs
				// before permission is granted. Request the default mic stream first.
				return requestAudioStreamWithFallback();
			}

			const stream = await requestAudioStream({
				...WHISPER_RECOMMENDED_MEDIA_TRACK_CONSTRAINTS,
				deviceId: { exact: recordingDeviceId },
			});
			return stream;
		},
		mapError: (error): RecordingServiceError => ({
			name: 'RecordingServiceError',
			message:
				'Unable to connect to the selected microphone. This could be because the device is already in use by another application, has been disconnected, or lacks proper permissions. Please check that your microphone is connected, not being used elsewhere, and that you have granted microphone permissions.',
			context: {
				recordingDeviceId,
				hasPermission,
				...getErrorDetails(error),
				...getBrowserAudioDiagnostics(),
			},
			cause: error,
		}),
	});
}

export async function getRecordingStream(
	selectedDeviceId: string | null,
	sendStatus: UpdateStatusMessageFn,
): Promise<
	Result<
		{ stream: MediaStream; deviceOutcome: DeviceAcquisitionOutcome },
		RecordingServiceError
	>
> {
	// Try preferred device first if specified
	if (!selectedDeviceId) {
		// No device selected
		sendStatus({
			title: '🔍 No Device Selected',
			description:
				"No worries! We'll find the best microphone for you automatically...",
		});
		try {
			const stream = await requestAudioStreamWithFallback();
			return Ok({
				stream,
				deviceOutcome: { outcome: 'success' },
			});
		} catch {
			// Fall through and continue with device enumeration fallback logic.
		}
	} else {
		sendStatus({
			title: '🎯 Connecting Device',
			description:
				'Almost there! Just need your permission to use the microphone...',
		});

		const { data: preferredStream, error: getPreferredStreamError } =
			await getStreamForDeviceId(selectedDeviceId);

		if (!getPreferredStreamError) {
			return Ok({
				stream: preferredStream,
				deviceOutcome: { outcome: 'success' },
			});
		}

		// We reach here if the preferred device failed, so we'll fall back to the first available device
		sendStatus({
			title: '⚠️ Finding a New Microphone',
			description:
				"That microphone isn't working. Let's try finding another one...",
		});
	}

	// Try to get any available device as fallback
	const getFirstAvailableStream = async (): Promise<
		Result<{ stream: MediaStream; deviceId: string }, RecordingServiceError>
	> => {
		const { data: recordingDevices, error: enumerateDevicesError } =
			await enumerateRecordingDevices();
		if (enumerateDevicesError)
			return Err({
				name: 'RecordingServiceError',
				message:
					'Error enumerating recording devices and acquiring first available stream. Please make sure you have given permission to access your audio devices',
				cause: enumerateDevicesError,
			});

		for (const device of recordingDevices) {
			const { data: stream, error } = await getStreamForDeviceId(
				device.deviceId,
			);
			if (!error) {
				return Ok({ stream, deviceId: device.deviceId });
			}
		}

		return Err({
			name: 'RecordingServiceError',
			message: 'Unable to connect to any available microphone',
			context: { recordingDevices },
			cause: undefined,
		});
	};

	// Get fallback stream
	const { data: fallbackStreamData, error: getFallbackStreamError } =
		await getFirstAvailableStream();
	if (getFallbackStreamError) {
		const errorMessage = selectedDeviceId
			? "We couldn't connect to any microphones. Make sure they're plugged in and try again!"
			: "Hmm... We couldn't find any microphones to use. Check your connections and try again!";
		return Err({
			name: 'RecordingServiceError',
			message: errorMessage,
			context: { selectedDeviceId },
			cause: getFallbackStreamError,
		});
	}

	const { stream: fallbackStream, deviceId: fallbackDeviceId } =
		fallbackStreamData;

	// Return the stream with appropriate device outcome
	if (!selectedDeviceId) {
		return Ok({
			stream: fallbackStream,
			deviceOutcome: {
				outcome: 'fallback',
				reason: 'no-device-selected',
				fallbackDeviceId,
			},
		});
	}
	return Ok({
		stream: fallbackStream,
		deviceOutcome: {
			outcome: 'fallback',
			reason: 'preferred-device-unavailable',
			fallbackDeviceId,
		},
	});
}

export function cleanupRecordingStream(stream: MediaStream) {
	for (const track of stream.getTracks()) {
		track.stop();
	}
}
