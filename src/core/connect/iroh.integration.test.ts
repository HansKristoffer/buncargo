import { afterAll, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Endpoint } from "@number0/iroh";
import { writeJsonDocument } from "../registry-file";
import { irohTestsEnabled } from "../runtime-flags";
import { newKeyPair, type ReceiverIdentity, receiverPath } from "./identity";
import { bindEndpoint } from "./iroh";
import type { RunInput } from "./protocol";
import { createPublisher } from "./publisher";
import { createReceiver } from "./receiver";
import type { LocalTarget } from "./targets";

/**
 * The real transport, end to end.
 *
 * It dials over n0's public relays and discovery exactly as a sandbox does,
 * so it needs network and stays out of the default suite. A fixture that
 * stubbed the endpoint would prove the parsers and nothing about the thing
 * this feature actually is.
 */
const run = irohTestsEnabled() ? test : test.skip;

const home = mkdtempSync(join(tmpdir(), "bc-iroh-"));
process.env.HOME = home;

const cleanup: Array<() => void | Promise<void>> = [];
afterAll(async () => {
	for (const close of cleanup.reverse()) {
		await close();
	}
	rmSync(home, { recursive: true, force: true });
});

async function listen(
	handler: (socket: Socket) => void,
): Promise<{ port: number; close: () => void }> {
	const server = createServer({ allowHalfOpen: true }, handler);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as { port: number }).port;
	return { port, close: () => server.close() };
}

function read(socket: Socket, bytes: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let seen = "";
		socket.on("data", (chunk) => {
			seen += chunk.toString();
			if (seen.length >= bytes) {
				resolve(seen);
			}
		});
		socket.once("error", reject);
		socket.once("end", () => resolve(seen));
	});
}

/** Revocation is persisted, so a receiver has to exist on disk exactly as it does in use. */
async function persistReceiver(secret: string): Promise<ReceiverIdentity> {
	const identity: ReceiverIdentity = { ...newKeyPair(), secret, denied: [] };
	await writeJsonDocument(receiverPath(), identity);
	return identity;
}

async function waitFor<T>(
	describe: string,
	probe: () => T | undefined | Promise<T | undefined>,
	timeoutMs = 60_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${describe}`);
		}
		await Bun.sleep(200);
	}
}

run(
	"a sandbox publishes over iroh and the receiver serves it on loopback",
	async () => {
		// An app that answers a request and one that streams, plus a raw TCP echo.
		const app = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/events") {
					return new Response(
						new ReadableStream({
							async start(controller) {
								controller.enqueue(Buffer.from("data: one\n\n"));
								await Bun.sleep(300);
								controller.enqueue(Buffer.from("data: two\n\n"));
								controller.close();
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				return new Response("hello from the sandbox");
			},
		});
		cleanup.push(() => app.stop(true));

		const echo = await listen((socket) => {
			socket.on("data", (chunk) => socket.write(chunk));
			socket.on("end", () => socket.end("bye"));
		});
		cleanup.push(echo.close);

		const identity = await persistReceiver("f".repeat(64));
		const receiver = createReceiver(identity);
		await receiver.start();
		cleanup.push(() => receiver.close());

		const keys = newKeyPair();
		const endpoint: Endpoint = await bindEndpoint(keys.secretKey);
		cleanup.push(() => endpoint.close());

		const targets: LocalTarget[] = [
			{
				id: "app-web",
				name: "web",
				kind: "app",
				protocol: "http",
				status: "ready",
				port: app.port as number,
			},
			{
				id: "service-db",
				name: "db",
				kind: "service",
				protocol: "tcp",
				status: "ready",
				preset: "postgres",
				port: echo.port,
			},
		];
		const input: RunInput = {
			sessionId: "session-one",
			name: "Integration",
			hostname: "sandbox",
			project: "example",
			branch: "main",
			worktree: null,
			primaryApp: "web",
			targets,
		};
		const publisher = createPublisher({
			endpoint,
			token: { endpointId: identity.endpointId, secret: identity.secret },
			name: "Integration",
			hostname: "sandbox",
		});
		cleanup.push(() => publisher.close());
		await publisher.update([{ input, targets }]);

		const directory = await waitFor("the run to appear", () => {
			const value = receiver.directory();
			return value.runs[0]?.targets.length === 2 ? value : undefined;
		});
		expect(directory.runs[0]?.publisherId).toBe(endpoint.id().toString());
		const web = directory.runs[0]?.targets[0];
		const db = directory.runs[0]?.targets[1];
		expect(web?.url).toStartWith("http://127.0.0.1:");
		expect(db?.url).toStartWith("postgresql://127.0.0.1:");

		// A whole HTTP response travels through the stream unchanged.
		const response = await fetch(web?.url as string);
		expect(await response.text()).toBe("hello from the sandbox");

		// SSE must arrive as it is produced, not buffered until the stream ends.
		const events = await fetch(`${web?.url}events`);
		const reader = (events.body as ReadableStream).getReader();
		const first = await reader.read();
		expect(Buffer.from(first.value as Uint8Array).toString()).toContain("one");
		await reader.cancel();

		// Raw TCP keeps both directions and half-close.
		const socket = connect({
			host: "127.0.0.1",
			port: db?.port as number,
			allowHalfOpen: true,
		});
		await once(socket, "connect");
		socket.write("ping");
		expect(await read(socket, 4)).toContain("ping");
		socket.end();
		socket.destroy();

		// Revoking closes the open connection and takes the run out of the directory.
		const held = connect({ host: "127.0.0.1", port: db?.port as number });
		await once(held, "connect");
		const closed = once(held, "close");
		await receiver.revoke(endpoint.id().toString());
		await closed;
		expect(receiver.directory().runs).toHaveLength(0);

		// The sandbox still holds a valid token, so publishing must keep failing.
		const refused = await waitFor(
			"the publisher to be refused",
			async () =>
				publisher
					.update([{ input, targets }])
					.then(() => undefined)
					.catch(() => true),
			15_000,
		);
		expect(refused).toBe(true);
	},
	120_000,
);

run(
	"a publisher without the receiver's secret is refused",
	async () => {
		const identity = await persistReceiver("1".repeat(64));
		const receiver = createReceiver(identity);
		await receiver.start();
		cleanup.push(() => receiver.close());

		const endpoint = await bindEndpoint(newKeyPair().secretKey);
		cleanup.push(() => endpoint.close());
		const publisher = createPublisher({
			endpoint,
			token: { endpointId: identity.endpointId, secret: "2".repeat(64) },
			name: "Impostor",
			hostname: "sandbox",
		});
		cleanup.push(() => publisher.close());

		await expect(publisher.update([])).rejects.toThrow();
		expect(receiver.directory().runs).toHaveLength(0);
	},
	120_000,
);
