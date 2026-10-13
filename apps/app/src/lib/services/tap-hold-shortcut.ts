/** One press toggles; only a press that started capture may finish it on a long release. */
export function createTapHoldShortcut(
	toggle: () => Promise<boolean>,
	finish: () => Promise<void>,
	now: () => number = () => performance.now(),
	minimumHoldMs = 1000,
) {
	let held: { at: number; started: Promise<boolean> } | undefined;
	let queue = Promise.resolve();
	return (state: 'Pressed' | 'Released') => {
		if (state === 'Pressed') {
			if (held) return; // Native key-repeat is not another toggle.
			const started = queue.then(toggle);
			held = {at: now(), started};
			queue = started.then(() => undefined, () => undefined);
		} else {
			const press = held;
			held = undefined;
			if (!press || now() - press.at < minimumHoldMs) return;
			queue = queue.then(async () => { if (await press.started) await finish(); }).catch(() => undefined);
		}
	};
}
