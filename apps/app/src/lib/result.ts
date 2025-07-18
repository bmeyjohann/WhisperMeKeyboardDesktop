import type { Err, Ok } from 'wellcrafted/result';
import type { TaggedError } from 'wellcrafted/error';
import type { ToastAndNotifyOptions } from '$lib/toasts.js';

export type WhisperingWarning = Omit<
	TaggedError<'WhisperingWarning'>,
	'message'
> &
	Omit<ToastAndNotifyOptions, 'variant'>;

export type WhisperingError = Omit<
	TaggedError<'WhisperingError'>,
	'message' | 'cause' | 'context'
> &
	Omit<ToastAndNotifyOptions, 'variant'>;

export type WhisperingResult<T> = Ok<T> | Err<WhisperingError>;

export type MaybePromise<T> = T | Promise<T>;

export const WhisperingError = (
	args: Omit<WhisperingError, 'name'>,
): WhisperingError => ({
	name: 'WhisperingError',
	...args,
});
