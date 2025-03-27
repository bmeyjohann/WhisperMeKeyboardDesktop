import type { MaybePromise, WhisperingResult } from '@repo/shared';

export type ClipboardService = {
	/**
	 * Reads the text from the user's clipboard.
	 */
	getClipboardText: () => Promise<WhisperingResult<string>>;

	/**
	 * Writes text to the user's clipboard.
	 * @param text The text to write to the clipboard.
	 */
	setClipboardText: (text: string) => Promise<WhisperingResult<void>>;

	/**
	 * Pastes text from the user's clipboard.
	 * - Web: No need to implement this function.
	 * - Desktop: This function should trigger a paste action, as if the user had pressed `Ctrl` + `V`.
	 * - Mobile: This function should trigger a paste action, as if the user had pressed `Paste` in the context menu.
	 */
	writeTextToCursor: (text: string) => MaybePromise<WhisperingResult<void>>;
};
