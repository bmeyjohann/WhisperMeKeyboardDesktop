import * as services from '$lib/services';
import type { Recording } from '$lib/services/db';
import type { DownloadServiceError } from '$lib/services/download';
import { Err, type Result } from 'wellcrafted/result';
import type { WhisperMeError } from '$lib/result';
import { defineMutation } from './_utils';

export const download = {
	downloadRecording: defineMutation({
		mutationKey: ['download', 'downloadRecording'] as const,
		resultMutationFn: async (
			recording: Recording,
		): Promise<Result<void, WhisperMeError | DownloadServiceError>> => {
			if (!recording.blob) {
				return Err({
					name: 'WhisperMeError',
					title: '⚠️ Recording blob not found',
					description: "Your recording doesn't have a blob to download.",
				} satisfies WhisperMeError);
			}

			return await services.download.downloadBlob({
				name: `whisperme_recording_${recording.id}`,
				blob: recording.blob,
			});
		},
	}),
};
