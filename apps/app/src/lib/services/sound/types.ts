import type { Result } from 'wellcrafted/result';
import type { TaggedError } from 'wellcrafted/error';
import type { WhisperMeSoundNames } from '$lib/constants/sounds';

export type PlaySoundServiceError = TaggedError<'PlaySoundServiceError'>;

export type PlaySoundService = {
	playSound: (
		soundName: WhisperMeSoundNames,
	) => Promise<Result<void, PlaySoundServiceError>>;
};
