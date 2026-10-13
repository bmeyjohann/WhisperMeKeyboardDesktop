/**
 * Recording mode constants and options
 */

export const RECORDING_MODES = [
	'manual',
	'vad',
	// 'live',
	'cpal'
] as const;
export type RecordingMode = (typeof RECORDING_MODES)[number];

export const RECORDING_MODE_OPTIONS = [
	{ label: 'Manual', value: 'manual', icon: '🎙️', desktopOnly: false },
	{ label: 'Voice Activated', value: 'vad', icon: '🎤', desktopOnly: false },
	// { label: 'Live', value: 'live', icon: '🎬', desktopOnly: false },
	{ label: 'CPAL', value: 'cpal', icon: '🔊', desktopOnly: true },
] as const satisfies {
	label: string;
	value: RecordingMode;
	icon: string;
	desktopOnly: boolean;
}[];
