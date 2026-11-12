import { afterEach, expect, test } from "bun:test";
import { ConnectionDirectory } from "../../../server/connect/directory";
import { createAPI } from "../../../server/connect/http";
import { Store } from "../../../server/connect/store";
import { runEntry } from "../run-registry.testing";
import { newCredential } from "./credentials";
import { createPublisher } from "./publisher";

const cleanups: (() => void | Promise<void>)[] = [];

// Last started, first ended: the publisher retires its publication before the relay stops.
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The relay's directory behind its real API, on loopback. */
function relay() {
	const store = new Store(":memory:", Buffer.alloc(32, 3));
	const directory = new ConnectionDirectory(store, "https://connect.test", {
		host: "connect.test",
		port: 7000,
		serverName: "connect.test",
	});
	const api = createAPI(directory);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => api(request),
	});
	cleanups.push(() => {
		server.stop(true);
		store.close();
	});
	return { directory, store, origin: `http://127.0.0.1:${server.port}` };
}

/** A run whose only target is still starting, so no tunnel is opened. */
const run = runEntry({
	sessionId: "run-a",
	cli: { program: process.execPath },
	pid: process.pid,
	root: "/tmp/fixture",
	projectPrefix: "test",
	projectName: "test",
	services: [
		{ name: "db", preset: "postgres", port: 5432, status: "starting" },
	],
});

test("a publication the relay forgot is registered again on the next refresh", async () => {
	const { directory, store, origin } = relay();
	const receiver = directory.createReceiver();
	const publisher = createPublisher({
		sessionId: run.sessionId,
		tokens: [receiver.token],
		name: "Cursor",
		origin,
		credential: newCredential("pub"),
	});
	cleanups.push(() => publisher.close());

	await publisher.refresh(run);
	expect(directory.list(receiver.owner).runs).toHaveLength(1);
	// Collected a day after it expired, as after a laptop slept that long.
	for (const publication of store.list<{ id: string }>("publications"))
		store.delete("publications", publication.id);

	await publisher.refresh(run);
	expect(directory.list(receiver.owner).runs).toHaveLength(1);
});
