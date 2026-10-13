import type { Err, Ok } from 'wellcrafted/result';
import type { TaggedError } from 'wellcrafted/error';
import type { ToastAndNotifyOptions } from '$lib/toasts.js';

export type WhisperMeWarning = Omit<
	TaggedError<'WhisperMeWarning'>,
	'message'
> &
	Omit<ToastAndNotifyOptions, 'variant'>;

export type WhisperMeError = Omit<
	TaggedError<'WhisperMeError'>,
	'message' | 'cause' | 'context'
> &
	Omit<ToastAndNotifyOptions, 'variant'>;

export type WhisperMeResult<T> = Ok<T> | Err<WhisperMeError>;

export type MaybePromise<T> = T | Promise<T>;

export const WhisperMeError = (
	args: Omit<WhisperMeError, 'name'>,
): WhisperMeError => ({
	name: 'WhisperMeError',
	...args,
});
