/**
 * @fileoverview Migration-free settings management system
 *
 * This module implements a robust settings system that eliminates the need for
 * version migrations. Instead of maintaining multiple schema versions and migration
 * functions, we use a progressive validation approach that:
 *
 * 1. Preserves valid settings from any previous version
 * 2. Silently discards invalid or unknown keys
 * 3. Applies defaults for missing required fields
 *
 * ## Design Decisions
 *
 * - **Flat key structure**: All settings use dot-notation keys (e.g., 'sound.playOn.manual-start')
 *   stored as a single-level object. This simplifies validation and merging.
 *
 * - **Schema with defaults**: Every field in the schema has a `.default()` value,
 *   ensuring we can always produce a valid settings object.
 *
 * - **Progressive validation**: When full validation fails, we attempt partial validation
 *   and finally key-by-key validation to recover as much valid data as possible.
 *
 * ## Benefits over versioned schemas
 *
 * - No migration code to maintain
 * - Automatic forward compatibility
 * - Graceful handling of corrupted settings
 * - Simpler codebase
 * - Easy to add/remove/rename settings
 */

import type { Command } from '$lib/commands';
import {
	BITRATE_VALUES_KBPS,
	DEFAULT_BITRATE_KBPS,
	RECORDING_MODES,
} from '$lib/constants/audio';
import { TRANSCRIPTION_SERVICE_IDS } from '$lib/constants/transcription';
import { SUPPORTED_LANGUAGES } from '$lib/constants/languages';
import { ALWAYS_ON_TOP_VALUES } from '$lib/constants/ui';
import type { WhisperingSoundNames } from '$lib/constants/sounds';
import type {
	ElevenLabsModel,
	GroqModel,
	OpenAIModel,
} from '$lib/constants/transcription/models';
import { CommandOrAlt, CommandOrControl } from '$lib/constants/keyboard';
import { type ZodBoolean, type ZodString, z } from 'zod';

/**
 * The main settings schema that defines all application settings.
 *
 * All settings are stored as a flat object with dot-notation keys for logical grouping.
 * Every field has a default value to ensure the application can always start with valid settings.
 *
 * ## Key naming conventions:
 * - `sound.playOn.*` - Sound effect toggles for various events
 * - `transcription.*` - Transcription service configuration
 * - `transformation.*` - Text transformation settings
 * - `recording.*` - Recording mode and device settings
 * - `shortcuts.*` - Keyboard shortcut mappings
 * - `apiKeys.*` - Service API keys
 * - `system.*` - System-level preferences
 * - `database.*` - Data retention policies
 *
 * @example
 * // Access a setting
 * const shouldPlaySound = settings.value['sound.playOn.manual-start'];
 *
 * // Update a setting
 * settings.value = {
 *   ...settings.value,
 *   'transcription.outputLanguage': 'en'
 * };
 */
export const settingsSchema = z.object({
	...({
		'sound.playOn.manual-start': z.boolean().default(true),
		'sound.playOn.manual-stop': z.boolean().default(true),
		'sound.playOn.manual-cancel': z.boolean().default(true),
		'sound.playOn.cpal-start': z.boolean().default(true),
		'sound.playOn.cpal-stop': z.boolean().default(true),
		'sound.playOn.cpal-cancel': z.boolean().default(true),
		'sound.playOn.vad-start': z.boolean().default(true),
		'sound.playOn.vad-capture': z.boolean().default(true),
		'sound.playOn.vad-stop': z.boolean().default(true),
		'sound.playOn.transcriptionComplete': z.boolean().default(true),
		'sound.playOn.transformationComplete': z.boolean().default(true),
	} satisfies Record<
		`sound.playOn.${WhisperingSoundNames | 'cpal-start' | 'cpal-stop' | 'cpal-cancel'}`,
		z.ZodDefault<ZodBoolean>
	>),

	'transcription.clipboard.copyOnSuccess': z.boolean().default(true),
	'transcription.clipboard.pasteOnSuccess': z.boolean().default(false),
	'transformation.clipboard.copyOnSuccess': z.boolean().default(true),
	'transformation.clipboard.pasteOnSuccess': z.boolean().default(false),

	'system.closeToTray': z.boolean().default(false),
	'system.alwaysOnTop': z.enum(ALWAYS_ON_TOP_VALUES).default('Never'),

	'database.recordingRetentionStrategy': z
		.enum(['keep-forever', 'limit-count'])
		.default('keep-forever'),
	'database.maxRecordingCount': z
		.string()
		.regex(/^\d+$/, 'Must be a number')
		.default('100'),

	// Recording mode settings
	'recording.mode': z.enum(RECORDING_MODES).default('manual'),

	// Navigator settings (shared by manual, VAD, and live modes)
	'recording.navigator.selectedDeviceId': z.string().nullable().default(null),
	'recording.navigator.bitrateKbps': z
		.enum(BITRATE_VALUES_KBPS)
		.optional()
		.default(DEFAULT_BITRATE_KBPS),

	// CPAL mode settings (native only)
	'recording.cpal.selectedDeviceId': z.string().nullable().default(null),

	'transcription.selectedTranscriptionService': z
		.enum(TRANSCRIPTION_SERVICE_IDS)
		.default('Groq'),
	// Shared settings in transcription
	'transcription.outputLanguage': z.enum(SUPPORTED_LANGUAGES).default('auto'),
	'transcription.prompt': z.string().default(''),
	'transcription.temperature': z.string().default('0.0'),

	// Service-specific settings
	'transcription.openai.model': z
		.string()
		.transform((val) => val as (string & {}) | OpenAIModel['name'])
		.default('gpt-4o-mini-transcribe' satisfies OpenAIModel['name']),
	'transcription.elevenlabs.model': z
		.string()
		.transform((val) => val as (string & {}) | ElevenLabsModel['name'])
		.default('scribe_v1' satisfies ElevenLabsModel['name']),
	'transcription.groq.model': z
		.string()
		.transform((val) => val as (string & {}) | GroqModel['name'])
		.default('whisper-large-v3-turbo' satisfies GroqModel['name']),
	'transcription.speaches.baseUrl': z.string().default('http://localhost:8000'),
	'transcription.speaches.modelId': z
		.string()
		.default('Systran/faster-distil-whisper-small.en'),

	'transformations.selectedTransformationId': z
		.string()
		.nullable()
		.default(null),

	'apiKeys.openai': z.string().default(''),
	'apiKeys.anthropic': z.string().default(''),
	'apiKeys.groq': z.string().default(''),
	'apiKeys.google': z.string().default(''),
	'apiKeys.elevenlabs': z.string().default(''),

	...({
		'shortcuts.local.toggleManualRecording': z
			.string()
			.nullable()
			.default(' '),
		'shortcuts.local.cancelManualRecording': z
			.string()
			.nullable()
			.default('c'),
		'shortcuts.local.toggleCpalRecording': z.string().nullable().default(null),
		'shortcuts.local.cancelCpalRecording': z.string().nullable().default(null),
		'shortcuts.local.toggleVadRecording': z.string().nullable().default('v'),
		'shortcuts.local.pushToTalk': z.string().nullable().default('p'),
	} satisfies Record<
		`shortcuts.local.${Command['id']}`,
		z.ZodDefault<z.ZodNullable<ZodString>>
	>),

	...({
		'shortcuts.global.toggleManualRecording': z
			.string()
			.nullable()
			.default(`${CommandOrControl}+Shift+;`),
		'shortcuts.global.cancelManualRecording': z
			.string()
			.nullable()
			.default(`${CommandOrControl}+Shift+'`),
		'shortcuts.global.toggleCpalRecording': z.string().nullable().default(null),
		'shortcuts.global.cancelCpalRecording': z.string().nullable().default(null),
		'shortcuts.global.toggleVadRecording': z.string().nullable().default(null),
		'shortcuts.global.pushToTalk': z.string().nullable().default(`${CommandOrAlt}+Shift+D`),
	} satisfies Record<
		`shortcuts.global.${Command['id']}`,
		z.ZodDefault<z.ZodNullable<ZodString>>
	>),
});

/**
 * The TypeScript type for validated settings, inferred from the Zod schema.
 * This is the source of truth for all settings throughout the application.
 *
 * @see settingsSchema - The Zod schema that defines this type
 */
export type Settings = z.infer<typeof settingsSchema>;

/**
 * Get default settings by parsing an empty object, which will use all the .default() values
 * defined in the schema.
 *
 * @returns A complete settings object with all default values
 *
 * @example
 * // Get fresh default settings
 * const defaults = getDefaultSettings();
 * console.log(defaults['transcription.outputLanguage']); // 'auto'
 * console.log(defaults['sound.playOn.manual-start']); // true
 *
 * @example
 * // Reset a specific setting to default
 * const defaults = getDefaultSettings();
 * settings.value = {
 *   ...settings.value,
 *   'transcription.temperature': defaults['transcription.temperature']
 * };
 */
export function getDefaultSettings(): Settings {
	const result = settingsSchema.parse({});
	return result;
}

/**
 * Parses and validates stored settings using a three-tier progressive validation strategy.
 * This function ensures we always return valid settings, preserving as much user data as possible
 * while gracefully handling corrupted, outdated, or partial settings.
 *
 * ## Validation Strategy:
 *
 * 1. **Full validation** - Try to parse the entire stored value as-is
 * 2. **Partial validation** - If full validation fails, validate against a partial schema
 *    and merge valid keys with defaults
 * 3. **Key-by-key validation** - As a last resort, validate each key individually,
 *    keeping only valid key-value pairs
 *
 * @param storedValue - The raw value from storage (usually from localStorage)
 * @returns A valid Settings object, guaranteed to match the current schema
 *
 * @example
 * // Case 1: Valid settings pass through unchanged
 * const stored = { 'sound.playOn.manual-start': false, ...otherValidSettings };
 * const result = parseStoredSettings(stored);
 * console.log(result['sound.playOn.manual-start']); // false
 *
 * @example
 * // Case 2: Partially valid settings merge with defaults
 * const stored = {
 *   'sound.playOn.manual-start': false,  // valid
 *   'obsolete.setting': 'value',          // invalid - will be discarded
 *   // missing required settings will use defaults
 * };
 * const result = parseStoredSettings(stored);
 * console.log(result['sound.playOn.manual-start']); // false (preserved)
 * console.log(result['transcription.outputLanguage']); // 'auto' (default)
 *
 * @example
 * // Case 3: Individual values that fail validation use defaults
 * const stored = {
 *   'transcription.temperature': 'invalid', // wrong type
 *   'sound.playOn.manual-start': false,     // valid
 * };
 * const result = parseStoredSettings(stored);
 * console.log(result['transcription.temperature']); // '0.0' (default)
 * console.log(result['sound.playOn.manual-start']); // false (preserved)
 *
 * @example
 * // Case 4: Non-object input returns complete defaults
 * const result1 = parseStoredSettings(null);
 * const result2 = parseStoredSettings('corrupted');
 * const result3 = parseStoredSettings(undefined);
 * // All return getDefaultSettings()
 */
export function parseStoredSettings(storedValue: unknown): Settings {
	// First, try to parse the entire value
	const fullResult = settingsSchema.safeParse(storedValue);
	if (fullResult.success) {
		return fullResult.data;
	}

	// If it's not an object, return defaults
	if (typeof storedValue !== 'object' || storedValue === null) {
		return getDefaultSettings();
	}

	// Create a partial schema where all keys are optional
	// This allows us to validate incomplete settings objects
	const partialSchema = settingsSchema.partial();

	// Try parsing with the partial schema
	const partialResult = partialSchema.safeParse(storedValue);

	if (partialResult.success) {
		// The partial object is valid, now merge with defaults
		// This ensures all required keys exist
		const mergedSettings = {
			...getDefaultSettings(),
			...partialResult.data,
		};

		// Validate the merged result with the full schema
		// This step ensures the merged object is complete and valid
		const finalResult = settingsSchema.safeParse(mergedSettings);
		if (finalResult.success) {
			return finalResult.data;
		}
	}

	// If even partial validation fails, try key-by-key validation
	// This handles cases where individual values might be invalid
	const validatedSettings: Record<string, unknown> = {};

	// Since settings are flat (one layer deep), we can iterate through stored keys
	for (const [key, value] of Object.entries(
		storedValue as Record<string, unknown>,
	)) {
		// Create a test object with just this key
		// This isolates validation to prevent one bad value from invalidating others
		const testObject = { [key]: value };
		const testResult = partialSchema.safeParse(testObject);

		if (testResult.success && key in testResult.data) {
			// This key-value pair is valid, keep it
			validatedSettings[key] = value;
		}
		// Invalid keys are silently discarded
		// This includes unknown keys from old versions or corrupted values
	}

	// Merge validated keys with defaults
	// Defaults fill in any missing required fields
	const finalSettings = {
		...getDefaultSettings(),
		...validatedSettings,
	};

	// Do one final validation to ensure the result is valid
	// This should always succeed given our approach, but we check to be safe
	const result = settingsSchema.safeParse(finalSettings);
	if (result.success) {
		return result.data;
	}

	// If all else fails, return defaults
	// This ensures the app always has valid settings to work with
	return getDefaultSettings();
}
