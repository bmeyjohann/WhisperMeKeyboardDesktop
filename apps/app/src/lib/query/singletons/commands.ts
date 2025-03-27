import type { Command } from '@repo/shared';
import { getContext, setContext } from 'svelte';
import type { ManualRecorder } from './manualRecorder';
import type { Transcriber } from './transcriber';
import type { Transformer } from './transformer';
import type { VadRecorder } from './vadRecorder';
import { settings } from '$lib/stores/settings.svelte';

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
	transcriber,
	transformer,
}: {
	manualRecorder: ManualRecorder;
	vadRecorder: VadRecorder;
	transcriber: Transcriber;
	transformer: Transformer;
}) {
	return {
		toggleManualRecording: () => manualRecorder.toggleRecording(),
		cancelManualRecording: () => manualRecorder.cancelRecorderWithToast(),
		closeManualRecordingSession: () =>
			manualRecorder.closeRecordingSessionWithToast(),
		toggleVadRecording: () => vadRecorder.toggleVad(),
		pushToTalk: () => manualRecorder.toggleRecording(),
		transformClipboard: () =>
			transformer.transformClipboard({
				transformationId:
					settings.value['transformations.selectedTransformationId'],
			}),
	} satisfies Record<Command['id'], () => void>;
}
