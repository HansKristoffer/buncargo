import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { ConnectionDirectory } from "../../../server/connect/directory";
import { createAPI } from "../../../server/connect/http";
import { Store } from "../../../server/connect/store";
import { ensureReceiver, readDirectory, receiverPath } from "./client";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The relay's directory behind its real API, as this machine's connect origin. */
function relay() {
	const store = new Store(":memory:", Buffer.alloc(32, 4));
	let api: ReturnType<typeof createAPI> | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => api?.(request) ?? new Response(null, { status: 503 }),
	});
	const origin = `http://127.0.0.1:${server.port}`;
	const directory = new ConnectionDirectory(store, origin, {
		host: "127.0.0.1",
		port: 7000,
		serverName: "localhost",
	});
	api = createAPI(directory);
	const saved = process.env.BUNCARGO_CONNECT_URL;
	process.env.BUNCARGO_CONNECT_URL = origin;
	cleanups.push(async () => {
		if (saved === undefined) delete process.env.BUNCARGO_CONNECT_URL;
		else process.env.BUNCARGO_CONNECT_URL = saved;
		server.stop(true);
		store.close();
		await rm(receiverPath(), { force: true });
	});
	return directory;
}

test("a receiver the relay forgot names the command that registers it again", async () => {
	const directory = relay();
	const receiver = await ensureReceiver();
	directory.deleteReceiver(receiver.owner);

	await expect(readDirectory()).rejects.toThrow(
		"buncargo connect token --rotate",
	);
});

test("rotating a receiver the relay forgot registers a new one", async () => {
	const directory = relay();
	const forgotten = await ensureReceiver();
	directory.deleteReceiver(forgotten.owner);

	const receiver = await ensureReceiver(true);

	expect(receiver.id).not.toBe(forgotten.id);
	expect(receiver.token).not.toBe(forgotten.token);
	expect((await readDirectory()).configured).toBe(true);
});
