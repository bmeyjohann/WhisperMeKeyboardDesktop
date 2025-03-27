import { Ok, tryAsync } from '@epicenterhq/result';
import { extension } from '@repo/extension';
import { WhisperingErr } from '@repo/shared';
import type { ClipboardService } from './ClipboardService';

export function createClipboardServiceWeb(): ClipboardService {
	return {
		getClipboardText: async () =>
			tryAsync({
				try: () => navigator.clipboard.readText(),
				mapErr: (error) =>
					WhisperingErr({
						title: '⚠️ Unable to read clipboard',
						description:
							'There was an error reading from the clipboard using the browser Clipboard API. Please try again.',
						action: { type: 'more-details', error },
					}),
			}),

		setClipboardText: async (text) => {
			const setClipboardResult = await tryAsync({
				try: () => navigator.clipboard.writeText(text),
				mapErr: (error) =>
					WhisperingErr({
						title: '⚠️ Unable to copy to clipboard',
						description:
							'There was an error copying to the clipboard using the browser Clipboard API. Please try again.',
						action: { type: 'more-details', error },
					}),
			});

			if (!setClipboardResult.ok) {
				const extensionSetClipboardResult = await extension.setClipboardText({
					transcribedText: text,
				});
				if (!extensionSetClipboardResult.ok) {
					const errProperties = extensionSetClipboardResult.error;
					return errProperties._tag === 'ExtensionNotAvailableError'
						? setClipboardResult
						: WhisperingErr(errProperties);
				}
				return Ok(undefined);
			}
			return Ok(undefined);
		},

		writeTextToCursor: async (text) => {
			const writeTextToCursorResult = await extension.writeTextToCursor({
				transcribedText: text,
			});
			if (!writeTextToCursorResult.ok) {
				const errProperties = writeTextToCursorResult.error;
				if (errProperties._tag === 'ExtensionNotAvailableError') {
					return WhisperingErr({
						title: '⚠️ Extension Not Available',
						description:
							'The Whispering extension is not available. Please install it to enable writing transcribed text to the cursor.',
						action: { type: 'more-details', error: errProperties },
					});
				}
				return WhisperingErr(errProperties);
			}
			return Ok(undefined);
		},
	};
}
