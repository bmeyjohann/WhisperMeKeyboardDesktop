import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
const source = await readFile(
	new URL('../static/voice-pcm-worklet.js', import.meta.url),
	'utf8',
);
function create() {
	let Processor;
	const frames = [];
	const context = vm.createContext({
		AudioWorkletProcessor: class {
			port = { postMessage: (frame) => frames.push(frame) };
		},
		registerProcessor: (_name, type) => {
			Processor = type;
		},
		Uint8Array,
		DataView,
		Math,
	});
	vm.runInContext(source, context);
	return { processor: new Processor(), frames };
}
test('PCM frames are little endian mono and preserve final partial frame', () => {
	const { processor, frames } = create();
	processor.process([[new Float32Array(1600).fill(1)]]);
	assert.equal(frames.length, 1);
	assert.equal(frames[0].audio.length, 3200);
	assert.equal(new DataView(frames[0].audio.buffer).getInt16(0, true), 32767);
	processor.process([[new Float32Array(23).fill(-1)]]);
	processor.port.onmessage({ data: 'flush' });
	assert.equal(frames[1].audio.length, 46);
	assert.equal(new DataView(frames[1].audio.buffer).getInt16(0, true), -32767);
	assert.equal(frames[2].flushed, true);
});
test('stereo is mixed symmetrically and silence is still transmitted', () => {
	const { processor, frames } = create();
	processor.process([
		[new Float32Array(1600).fill(1), new Float32Array(1600).fill(-1)],
	]);
	assert.equal(frames.length, 1);
	assert.ok(frames[0].audio.every((byte) => byte === 0));
});
