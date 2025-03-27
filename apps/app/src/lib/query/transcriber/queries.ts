import { transcriberKeys } from '.';
import { queryClient } from '..';

export function useIsCurrentlyTranscribing() {
	return {
		isCurrentlyTranscribing: () => {
			return (
				queryClient.isMutating({
					mutationKey: transcriberKeys.transcribe,
				}) > 0
			);
		},
	};
}
