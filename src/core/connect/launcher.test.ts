import { afterEach, expect, test } from "bun:test";
import { request } from "./client";
import type { CoordinatorState } from "./coordinator-state";
import { requestCoordinator } from "./launcher";

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
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
