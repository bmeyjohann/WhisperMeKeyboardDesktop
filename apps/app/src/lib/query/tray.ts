import * as services from '$lib/services';
import type { WhisperMeRecordingState } from '$lib/constants/audio';
import { settings } from '$lib/stores/settings.svelte';
import type { WhisperMeError } from '$lib/result';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { defineMutation } from './_utils';

const setTrayIconKeys = {
	setTrayIcon: ['setTrayIcon', 'setTrayIcon'] as const,
};

export const tray = {
	setTrayIcon: defineMutation({
		mutationKey: setTrayIconKeys.setTrayIcon,
		resultMutationFn: async ({
			icon,
		}: {
			icon: WhisperMeRecordingState;
		}): Promise<Result<void, WhisperMeError>> => {
			const { data, error } = await services.tray.setTrayIcon(icon);

			if (error) {
				return Err({
					name: 'WhisperMeError',
					title: '⚠️ Failed to set tray icon',
					description: error.message,
					action: { type: 'more-details', error },
				});
			}

			return Ok(data);
		},
	}),
};
