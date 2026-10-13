export const DEV_RECORDING_INPUT_MODES = [
	'microphone',
	'disabled',
	'sample',
] as const;

export type DevRecordingInputMode = (typeof DEV_RECORDING_INPUT_MODES)[number];

export const DEV_RECORDING_INPUT_MODE_OPTIONS = [
	{
		value: 'microphone',
		label: 'Microphone (Default)',
	},
	{
		value: 'disabled',
		label: 'Disabled (No Mic Capture)',
	},
	{
		value: 'sample',
		label: 'Sample Audio (No Mic Capture)',
	},
] as const satisfies { value: DevRecordingInputMode; label: string }[];
