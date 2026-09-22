import { once } from "node:events";
import type { Duplex } from "node:stream";
import type { BiStream } from "@number0/iroh";

const CHUNK = 64 * 1024;

/** A control line is metadata; anything larger is a publisher misbehaving. */
const MAX_LINE = 64 * 1024;

function toBuffer(chunk: Array<number> | null | undefined): Buffer {
	return chunk?.length ? Buffer.from(chunk) : Buffer.alloc(0);
}

/**
 * Newline-delimited JSON over one QUIC stream, then raw bytes.
 *
 * The handshake and the payload share a stream, so the reader has to hand
 * back whatever it read past the newline: those bytes are already the
 * application's.
 */
export class MessageStream {
	private rest = Buffer.alloc(0);

	constructor(readonly stream: BiStream) {}

	async send(message: unknown): Promise<void> {
		await this.stream.send.writeAll(
			Array.from(Buffer.from(`${JSON.stringify(message)}\n`)),
		);
	}

	/** One message, or undefined when the peer finished without sending another. */
	async receive(): Promise<unknown> {
		for (;;) {
			const end = this.rest.indexOf(10);
			if (end >= 0) {
				const line = this.rest.subarray(0, end);
				this.rest = this.rest.subarray(end + 1);
				return JSON.parse(line.toString());
			}
			if (this.rest.length > MAX_LINE) {
				throw new Error("Connection message too large");
			}
			const chunk = toBuffer(await this.stream.recv.read(CHUNK));
			if (!chunk.length) {
				return undefined;
			}
			this.rest = Buffer.concat([this.rest, chunk]);
		}
	}

	/** Bytes read past the last message, which belong to the bridged connection. */
	takeRest(): Buffer {
		const rest = this.rest;
		this.rest = Buffer.alloc(0);
		return rest;
	}
}

async function write(socket: Duplex, chunk: Buffer): Promise<void> {
	if (!socket.write(chunk)) {
		await once(socket, "drain");
	}
}

/**
 * Join a local socket to a QUIC stream in both directions.
 *
 * Each direction ends independently: a client that half-closes after its
 * request still reads the response, which is what a database protocol and a
 * piped HTTP upload both rely on. Either side failing destroys the pair, so a
 * dead stream can never leave a socket accepting bytes nothing will carry.
 */
export function bridge(socket: Duplex, messages: MessageStream): Promise<void> {
	const { send, recv } = messages.stream;
	const rest = messages.takeRest();
	let failed = false;

	const fail = (error: unknown) => {
		if (!failed) {
			failed = true;
			socket.destroy();
			void send.reset(0n).catch(() => {});
			void recv.stop(0n).catch(() => {});
		}
		return error;
	};

	const toSocket = (async () => {
		if (rest.length) {
			await write(socket, rest);
		}
		for (;;) {
			const chunk = toBuffer(await recv.read(CHUNK));
			if (!chunk.length) {
				socket.end();
				return;
			}
			await write(socket, chunk);
		}
	})();

	const toStream = (async () => {
		for await (const chunk of socket) {
			await send.writeAll(Array.from(chunk as Buffer));
		}
		await send.finish();
	})();

	return Promise.all([toSocket, toStream]).then(
		() => undefined,
		(error) => {
			throw fail(error);
		},
	);
}
