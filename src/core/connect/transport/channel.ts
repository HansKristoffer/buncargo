import { Duplex } from "node:stream";

const HIGH_WATER = 256 * 1024;
const MAX_BUFFER = 4 * 1024 * 1024;
export interface Wire {
	send(data: Uint8Array): void;
	close(): void;
	buffered(): number;
}
/** Byte stream over binary WebSocket frames: data, FIN, pause, resume and byte-credit ACKs. */
export class Channel extends Duplex {
	private suspended = false;
	private unacknowledged = 0;
	private remoteEnded = false;
	private blocked: (() => void) | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	constructor(private wire: Wire) {
		super({ allowHalfOpen: true, highWaterMark: HIGH_WATER });
	}
	receive(data: Uint8Array) {
		if (this.destroyed) return;
		if (!data.length || data.length > 65537) {
			this.destroy(new Error("Invalid stream frame"));
			return;
		}
		switch (data[0]) {
			case 4: {
				if (data.length !== 5) break;
				const count = new DataView(
					data.buffer,
					data.byteOffset,
					data.byteLength,
				).getUint32(1);
				if (!count || count > this.unacknowledged) break;
				this.unacknowledged -= count;
				this.blocked?.();
				return;
			}
			case 0: {
				if (this.remoteEnded || this.readableLength > MAX_BUFFER) {
					this.destroy(new Error("Stream limit exceeded"));
					return;
				}
				if (!this.push(Buffer.from(data.subarray(1))))
					this.wire.send(new Uint8Array([2]));
				const ack = new Uint8Array(5);
				ack[0] = 4;
				new DataView(ack.buffer).setUint32(1, data.length);
				this.wire.send(ack);
				return;
			}
			case 1:
				if (data.length !== 1 || this.remoteEnded) break;
				this.remoteEnded = true;
				this.push(null);
				return;
			case 2:
				if (data.length !== 1) break;
				this.suspended = true;
				return;
			case 3:
				if (data.length !== 1) break;
				this.suspended = false;
				this.blocked?.();
				return;
		}
		this.destroy(new Error("Invalid stream control"));
	}
	override _read() {
		if (!this.destroyed) this.wire.send(new Uint8Array([3]));
	}
	override _write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	) {
		let offset = 0;
		const flush = () => {
			if (this.destroyed) {
				callback(new Error("Connection closed"));
				return;
			}
			while (
				offset < chunk.length &&
				!this.suspended &&
				this.unacknowledged < 128 * 1024 &&
				this.wire.buffered() < HIGH_WATER
			) {
				const end = Math.min(offset + 65536, chunk.length);
				const frame = new Uint8Array(end - offset + 1);
				frame.set(chunk.subarray(offset, end), 1);
				this.unacknowledged += frame.length;
				this.wire.send(frame);
				offset = end;
			}
			if (offset === chunk.length) {
				this.blocked = undefined;
				callback();
				return;
			}
			this.blocked = () => {
				if (this.timer) clearTimeout(this.timer);
				this.timer = undefined;
				flush();
			};
			if (!this.timer)
				this.timer = setTimeout(() => {
					this.timer = undefined;
					flush();
				}, 10);
		};
		flush();
	}
	override _final(callback: (error?: Error | null) => void) {
		this.wire.send(new Uint8Array([1]));
		callback();
	}
	override _destroy(
		error: Error | null,
		callback: (error: Error | null) => void,
	) {
		if (this.timer) clearTimeout(this.timer);
		this.blocked = undefined;
		this.wire.close();
		callback(error);
	}
}
