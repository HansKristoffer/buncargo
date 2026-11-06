import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { readCurrentProcessIdentity } from "../process-identity";
import { request } from "./client";
import {
	type CoordinatorState,
	coordinatorStatePath,
	writeCoordinatorState,
} from "./coordinator-state";
import {
	awaitCoordinator,
	coordinatorWentAway,
	requestCoordinator,
} from "./launcher";

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	await rm(coordinatorStatePath(), { force: true });
});

/** A live coordinator (this process) whose last heartbeat landed `ageMs` ago. */
function liveCoordinator(ageMs: number): CoordinatorState {
	return {
		pid: process.pid,
		identity: readCurrentProcessIdentity() ?? "",
		bundle: "bundle",
		updatedAt: Date.now() - ageMs,
		ready: true,
		connection: { port: 1, token: "local" },
		cli: { program: process.execPath },
	};
}

test("an adopted coordinator whose heartbeat stopped is named, not waited on", async () => {
	const wedged = liveCoordinator(60_000);
	await writeCoordinatorState(wedged);

	await expect(awaitCoordinator(wedged, true)).rejects.toThrow(
		`kill ${process.pid}`,
	);
});

test("an adopted coordinator that starts leaving is reported gone, to be replaced", async () => {
	const adopted = liveCoordinator(60_000);
	await writeCoordinatorState({
		...adopted,
		ready: false,
		updatedAt: Date.now(),
	});

	const error = await awaitCoordinator(adopted, true).catch(
		(caught: unknown) => caught,
	);

	expect(coordinatorWentAway(error)).toBe(true);
});

test("an adopted coordinator that reports again is used", async () => {
	const waking = liveCoordinator(60_000);
	await writeCoordinatorState(waking);

	const waited = awaitCoordinator(waking, true);
	await writeCoordinatorState({ ...waking, updatedAt: Date.now() });

	await waited;
});

function coordinatorAt(port: number): CoordinatorState {
	return {
		pid: process.pid,
		identity: "test",
		bundle: "bundle",
		updatedAt: Date.now(),
		ready: true,
		connection: { port, token: "local" },
		cli: { program: process.execPath },
	};
}

function serve(fetch: (request: Request) => Response): number {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
	servers.push(server);
	return Number(server.port);
}

/** A port nothing listens on: the coordinator that just exited idle. */
function goneCoordinatorPort(): number {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = Number(server.port);
	server.stop(true);
	return port;
}

/** Each `ensure` adopts or starts the next coordinator in line. */
function coordinators(...states: (CoordinatorState | undefined)[]) {
	let current: CoordinatorState | undefined;
	let ensured = 0;
	return {
		get ensured() {
			return ensured;
		},
		deps: {
			ensure: async () => {
				current = states[ensured++];
			},
			readState: async () => current,
			send: request,
		},
	};
}

test("a coordinator that exited after it was adopted is started again and asked once more", async () => {
	const replacement = serve(() =>
		Response.json({ host: "127.0.0.1", port: 4100 }),
	);
	const line = coordinators(
		coordinatorAt(goneCoordinatorPort()),
		coordinatorAt(replacement),
	);

	expect(
		await requestCoordinator<object>("/tcp", { id: "db" }, line.deps),
	).toEqual({ host: "127.0.0.1", port: 4100 });
	expect(line.ensured).toBe(2);
});

test("a coordinator whose state is gone by the time it is read is started again", async () => {
	const replacement = serve(() => Response.json({ ok: true }));
	const line = coordinators(undefined, coordinatorAt(replacement));

	expect(
		await requestCoordinator<object>("/disconnect", { id: "db" }, line.deps),
	).toEqual({ ok: true });
	expect(line.ensured).toBe(2);
});

test("an error the coordinator answered with is not retried", async () => {
	const port = serve(() =>
		Response.json({ error: "Target is not shared" }, { status: 502 }),
	);
	const line = coordinators(coordinatorAt(port), coordinatorAt(port));

	await expect(
		requestCoordinator("/tcp", { id: "db" }, line.deps),
	).rejects.toThrow("Target is not shared");
	expect(line.ensured).toBe(1);
});

test("a coordinator that is gone twice fails with the second error", async () => {
	const line = coordinators(
		coordinatorAt(goneCoordinatorPort()),
		coordinatorAt(goneCoordinatorPort()),
	);

	await expect(
		requestCoordinator("/tcp", { id: "db" }, line.deps),
	).rejects.toThrow("Unable to connect");
	expect(line.ensured).toBe(2);
});
