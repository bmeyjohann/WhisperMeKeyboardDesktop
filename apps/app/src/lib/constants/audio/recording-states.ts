/**
 * Recording state constants and schemas
 */
import { z } from 'zod';

export const recordingStateSchema = z.enum(['IDLE', 'RECORDING']);

export type WhisperMeRecordingState = z.infer<typeof recordingStateSchema>;

export type CancelRecordingResult =
	| { status: 'cancelled' }
	| { status: 'no-recording' };

export const recorderStateToIcons = {
	IDLE: '🎙️',
	RECORDING: '⏹️',
} as const satisfies Record<WhisperMeRecordingState, string>;

export const cpalStateToIcons = {
	IDLE: '🎙️',
	RECORDING: '⏹️',
} as const satisfies Record<WhisperMeRecordingState, string>;

export const vadStateSchema = z.enum(['IDLE', 'LISTENING', 'SPEECH_DETECTED']);

export type VadState = z.infer<typeof vadStateSchema>;

export const vadStateToIcons = {
	IDLE: '🎤',
	LISTENING: '💬',
	SPEECH_DETECTED: '👂',
} as const satisfies Record<VadState, string>;