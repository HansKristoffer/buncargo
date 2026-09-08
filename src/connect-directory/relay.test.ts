import { expect, test } from "bun:test";
import { RecipientRelay, type RelaySocket } from "./relay";
import type { DeviceState } from "./service";

class Socket implements RelaySocket {
	closed = false;
	sent: (string | Uint8Array | ArrayBuffer)[] = [];
	send(data: string | Uint8Array | ArrayBuffer) {
		this.sent.push(data);
	}
	close() {
		this.closed = true;
	}
}
test("relay rejects senders that ignore flow control without dropping other sessions", () => {
	const relay = new RecipientRelay({
		recipient: "device",
		origin: "https://directory.example",
		key: {},
		load: async () => undefined,
	});
	const publisher = new Socket(),
		client = new Socket(),
		pipe = new Socket();
	try {
		relay.open(
			{ role: "publisher", session: "session", hash: "owner" },
			publisher,
		);
		const listener = relay.open(
			{
				role: "client",
				id: "stream",
				session: "session",
				hash: "owner",
				target: "db",
				capability: "token",
				expiresAt: Date.now() + 60000,
			},
			client,
		);
		relay.open(
			{ role: "pipe", id: "stream", session: "session", hash: "owner" },
			pipe,
		);
		const data = new Uint8Array(65537);
		for (let i = 0; i < 5; i++) listener.message(data);
		expect(client.closed).toBe(true);
		expect(pipe.closed).toBe(true);
		expect(publisher.closed).toBe(false);
	} finally {
		relay.stop();
	}
});
test("false credit acknowledgements and malformed frames close the stream", () => {
	for (const frame of [
		new Uint8Array([4, 0, 0, 0, 1]),
		new Uint8Array([2, 1]),
		new Uint8Array([9]),
	]) {
		const relay = new RecipientRelay({
			recipient: "device",
			origin: "https://directory.example",
			key: {},
			load: async () => undefined,
		});
		const client = new Socket();
		try {
			relay.open(
				{ role: "publisher", session: "session", hash: "owner" },
				new Socket(),
			);
			const listener = relay.open(
				{
					role: "client",
					id: "stream",
					session: "session",
					hash: "owner",
					target: "db",
					capability: "token",
					expiresAt: Date.now() + 60000,
				},
				client,
			);
			relay.open(
				{ role: "pipe", id: "stream", session: "session", hash: "owner" },
				new Socket(),
			);
			listener.message(frame);
			expect(client.closed).toBe(true);
		} finally {
			relay.stop();
		}
	}
});
test("revoked state closes controls and streams", () => {
	const relay = new RecipientRelay({
		recipient: "device",
		origin: "https://directory.example",
		key: {},
		load: async () => undefined,
	});
	const socket = new Socket();
	try {
		relay.open(
			{ role: "publisher", session: "session", hash: "owner" },
			socket,
		);
		relay.reconcile({ sessions: {} } as DeviceState);
		expect(socket.closed).toBe(true);
		expect(relay.ready("session")).toBe(false);
	} finally {
		relay.stop();
	}
});
