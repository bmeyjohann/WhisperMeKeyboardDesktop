/**
 * URL and pathname constants for the WhisperMe application
 */

export const WHISPERING_URL =
	process.env.NODE_ENV === 'production'
		? 'https://whisperme.app'
		: 'http://localhost:5173';

export const WHISPERING_URL_WILDCARD = `${WHISPERING_URL}/*` as const;

export const WHISPERING_RECORDINGS_PATHNAME = '/recordings' as const;

export const WHISPERING_SETTINGS_PATHNAME = '/settings' as const;