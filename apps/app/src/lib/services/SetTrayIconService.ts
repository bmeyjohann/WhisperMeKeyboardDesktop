import { goto } from '$app/navigation';
import { getRecorderFromContext } from '$lib/query/singletons/recorder';
import { settings } from '$lib/stores/settings.svelte';
import { Err, Ok, tryAsync } from '@epicenterhq/result';
import { extension } from '@repo/extension';
import {
	ALWAYS_ON_TOP_VALUES,
	type WhisperingRecordingState,
} from '@repo/shared';
import { CheckMenuItem, Menu, MenuItem } from '@tauri-apps/api/menu';
import { resolveResource } from '@tauri-apps/api/path';
import { TrayIcon } from '@tauri-apps/api/tray';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { exit } from '@tauri-apps/plugin-process';

const TRAY_ID = 'whispering-tray';

export type SetTrayIconServiceErr = Err<{
	_tag: 'TrayIconError';
	icon: WhisperingRecordingState;
}>;

export type SetTrayIconServiceResult<T> = Ok<T> | SetTrayIconServiceErr;

export const SetTrayIconServiceErr = (
	icon: WhisperingRecordingState,
): SetTrayIconServiceErr => Err({ _tag: 'TrayIconError', icon });

type SetTrayIconService = {
	setTrayIcon: (
		icon: WhisperingRecordingState,
	) => Promise<SetTrayIconServiceResult<void>>;
};

export function createSetTrayIconWebService(): SetTrayIconService {
	return {
		setTrayIcon: async (icon: WhisperingRecordingState) => {
			const setRecorderStateResult = await extension.setRecorderState({
				recorderState: icon,
			});
			if (!setRecorderStateResult.ok) return SetTrayIconServiceErr(icon);
			return Ok(undefined);
		},
	};
}

export function createSetTrayIconDesktopService(): SetTrayIconService {
	const trayPromise = initTray();
	return {
		setTrayIcon: (recorderState: WhisperingRecordingState) =>
			tryAsync({
				try: async () => {
					const iconPath = await getIconPath(recorderState);
					const tray = await trayPromise;
					return tray.setIcon(iconPath);
				},
				mapErr: (error) => SetTrayIconServiceErr(recorderState),
			}),
	};
}

async function initTray() {
	const existingTray = await TrayIcon.getById(TRAY_ID);
	if (existingTray) return existingTray;

	const alwaysOnTopItems = await Promise.all(
		ALWAYS_ON_TOP_VALUES.map(async (value) =>
			CheckMenuItem.new({
				id: `always-on-top-${value}`,
				text: `Always on Top: ${value}`,
				checked: settings.value['system.alwaysOnTop'] === value,
				action: async (id) => {
					settings.value = { ...settings.value, 'system.alwaysOnTop': value };

					// Update all menu items to ensure only the selected one is checked
					await Promise.all(
						alwaysOnTopItems.map(async (item) => {
							await item.setChecked(item.id === id);
						}),
					);
				},
			}),
		),
	);

	const trayMenu = await Menu.new({
		items: [
			// Window Controls Section
			await MenuItem.new({
				id: 'show',
				text: 'Show Window',
				action: () => getCurrentWindow().show(),
			}),

			await MenuItem.new({
				id: 'hide',
				text: 'Hide Window',
				action: () => getCurrentWindow().hide(),
			}),

			// Always on Top Section
			...alwaysOnTopItems,

			// Settings Section
			await MenuItem.new({
				id: 'settings',
				text: 'Settings',
				action: () => {
					goto('/settings');
					return getCurrentWindow().show();
				},
			}),

			// Quit Section
			await MenuItem.new({
				id: 'quit',
				text: 'Quit',
				action: () => void exit(0),
			}),
		],
	});

	const tray = await TrayIcon.new({
		id: TRAY_ID,
		icon: await getIconPath('IDLE'),
		menu: trayMenu,
		menuOnLeftClick: false,
		tooltip: 'Whispering',
		action: (e) => {
			if (
				e.type === 'Click' &&
				e.button === 'Left' &&
				e.buttonState === 'Down'
			) {
				const recorder = getRecorderFromContext();
				recorder.toggleRecording();
				return true;
			}
			return false;
		},
	});

	return tray;
}

async function getIconPath(recorderState: WhisperingRecordingState) {
	const iconPaths = {
		IDLE: 'recorder-state-icons/studio_microphone.png',
		SESSION: 'recorder-state-icons/studio_microphone.png',
		'SESSION+RECORDING': 'recorder-state-icons/red_large_square.png',
	} as const satisfies Record<WhisperingRecordingState, string>;
	return await resolveResource(iconPaths[recorderState]);
}
