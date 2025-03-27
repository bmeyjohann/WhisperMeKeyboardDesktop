import type { Command } from '@repo/shared';
import { getContext, setContext } from 'svelte';
import type { ManualRecorder } from './manualRecorder';
import type { VadRecorder } from './vadRecorder';
import { settings } from '$lib/stores/settings.svelte';
import { useTransformClipboard } from '$lib/query/transform/mutations';
import { nanoid } from 'nanoid/non-secure';
import { toast } from '$lib/services/toast';

export type CommandCallbacks = ReturnType<typeof createCommandCallbacks>;

export const initCommandsInContext = ({
	manualRecorder,
	vadRecorder,
}: {
	manualRecorder: ManualRecorder;
	vadRecorder: VadRecorder;
}) => {
	const commandCallbacks = createCommandCallbacks({
		manualRecorder,
		vadRecorder,
	});
	setContext('commandCallbacks', commandCallbacks);
	return commandCallbacks;
};

export const getCommandsFromContext = () => {
	return getContext<CommandCallbacks>('commandCallbacks');
};

function createCommandCallbacks({
	manualRecorder,
	vadRecorder,
}: {
	manualRecorder: ManualRecorder;
	vadRecorder: VadRecorder;
}) {
	const { transformClipboard } = useTransformClipboard();
	return {
		toggleManualRecording: () => manualRecorder.toggleRecording(),
		cancelManualRecording: () => manualRecorder.cancelRecorderWithToast(),
		closeManualRecordingSession: () =>
			manualRecorder.closeRecordingSessionWithToast(),
		toggleVadRecording: () => vadRecorder.toggleVad(),
		pushToTalk: () => manualRecorder.toggleRecording(),
		runSelectedTransformationOnClipboard: () => {
			if (!settings.value['transformations.selectedTransformationId']) {
				toast.error({
					title: 'No transformation selected',
					description:
						'Please select a transformation to transform the clipboard',
				});
				return;
			}
			return transformClipboard.mutate({
				transformationId:
					settings.value['transformations.selectedTransformationId'],
				toastId: nanoid(),
			});
		},
	} satisfies Record<Command['id'], () => void>;
}
