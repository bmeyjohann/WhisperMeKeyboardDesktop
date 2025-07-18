import { Err, Ok } from 'wellcrafted/result';
// import { extension } from '@repo/extension';
import type { NotificationService } from '.';

export function createNotificationServiceWeb(): NotificationService {
	return {
		notify: async (notifyOptions) => {
			// const { data: notificationId, error: createNotificationError } =
			// 	await extension.createNotification({
			// 		notifyOptions,
			// 	});
			// if (createNotificationError) return Err(createNotificationError);
			// return Ok(notificationId);
			return Ok('');
		},
		clear: async (notificationId: string) => {
			// const { error: clearNotificationError } =
			// 	await extension.clearNotification({
			// 		notificationId,
			// 	});
			// if (clearNotificationError) return Err(clearNotificationError);
			return Ok(undefined);
		},
	};
}
