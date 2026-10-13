class VoicePcmProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.buffer = [];
		this.pendingSamples = 0;
		this.stopped = false;
		this.port.onmessage = ({ data }) => {
			if (data === 'flush') {
				this.stopped = true;
				this.flush();
				this.port.postMessage({ flushed: true });
			}
			if (data && typeof data.ackBytes === 'number' && data.ackBytes > 0) {
				this.pendingSamples = Math.max(
					0,
					this.pendingSamples - data.ackBytes / 2,
				);
			}
		};
	}
	flush() {
		if (!this.buffer.length) return;
		const bytes = new Uint8Array(this.buffer.length * 2);
		const view = new DataView(bytes.buffer);
		this.buffer.forEach((value, index) =>
			view.setInt16(
				index * 2,
				Math.round(Math.max(-1, Math.min(1, value)) * 32767),
				true,
			),
		);
		this.buffer = [];
		this.port.postMessage({ audio: bytes }, [bytes.buffer]);
	}
	process(inputs) {
		if (this.stopped) return true;
		const channels = inputs[0];
		if (channels?.length) {
			for (let i = 0; i < channels[0].length; i++) {
				let value = 0;
				for (const channel of channels) value += channel[i];
				this.buffer.push(value / channels.length);
				this.pendingSamples++;
				if (this.buffer.length === 1600) this.flush();
				// Enforce the bound in the producer, even if the UI thread stalls.
				// Every accepted sample is emitted before announcing the stop.
				if (this.pendingSamples >= 16000 * 30) {
					this.stopped = true;
					this.flush();
					this.port.postMessage({ bufferFull: true });
					break;
				}
			}
		}
		return true;
	}
}
registerProcessor('voice-pcm', VoicePcmProcessor);
