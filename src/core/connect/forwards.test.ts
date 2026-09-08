import { expect, test } from "bun:test";
import { ConnectionForwards } from "./forwards";
import type { DirectorySnapshot, Registration } from "./protocol";
import type { BrowserPeers } from "./transport/browser-access";
import type { Forward, localForward } from "./transport/local-forward";

const fixture = (await Bun.file(
	new URL("../../../menubar/fixtures/connect.v1.json", import.meta.url),
).json()) as DirectorySnapshot;

function setup() {
	const run = structuredClone(fixture.runs[0]);
	const web = {
		...run.targets[0],
		id: "web",
		name: "web",
		protocol: "http" as const,
		status: "ready" as const,
	};
	run.targets = [
		web,
		{ ...web, id: "api", name: "api" },
		{ ...web, id: "db", name: "db", protocol: "tcp" },
	];
	const created: {
		forward: Forward;
		browser?: BrowserPeers;
		closed: boolean;
	}[] = [];
	const create: typeof localForward = async (endpoint, target, browser) => {
		const port = 40000 + created.length;
		const entry = {
			forward: {
				get closed(): boolean {
					return entry.closed;
				},
				endpoint,
				target: structuredClone(target),
				port,
				url: `${target.protocol}://127.0.0.1:${port}`,
				browserCookie:
					target.protocol === "http" ? `cookie-${port}` : undefined,
				close: async () => {
					entry.closed = true;
				},
			},
			browser,
			closed: false,
		};
		created.push(entry);
		return entry.forward;
	};
	const forwards = new ConnectionForwards(create);
	return { run, created, forwards };
}

const directory = (...runs: Registration[]): DirectorySnapshot => ({
	...fixture,
	runs,
});

test("reuses HTTP siblings, restores disconnected peers, and isolates session cookies", async () => {
	const { run, created, forwards } = setup();
	const web = await forwards.open(run, "web");
	expect(forwards.size).toBe(2);
	expect(await forwards.open(run, "web")).toBe(web);
	expect(created).toHaveLength(2);
	expect(created[0].browser?.cookies()).toEqual([
		"cookie-40000",
		"cookie-40001",
	]);
	await forwards.disconnect(run.sessionId, "api");
	expect(created[1].closed).toBe(true);
	expect(created[0].browser?.origins.has("http://127.0.0.1:40001")).toBe(false);
	expect(await forwards.open(run, "web")).toBe(web);
	expect(created).toHaveLength(3);
	expect(created[0].browser?.cookies()).toEqual([
		"cookie-40000",
		"cookie-40002",
	]);

	await forwards.open({ ...run, sessionId: "other-session" }, "web");
	expect(created[3].browser?.cookies()).toEqual([
		"cookie-40003",
		"cookie-40004",
	]);
	expect(created[0].browser?.cookies()).toEqual([
		"cookie-40000",
		"cookie-40002",
	]);
	await forwards.close();
	expect(forwards.size).toBe(0);
	expect(created.every((entry) => entry.closed)).toBe(true);
});

test("replaces changed ports, protocols and endpoints without replaying connections", async () => {
	const { run, created, forwards } = setup();
	await forwards.open(run, "db");
	expect(forwards.size).toBe(1);
	for (const replacement of [
		{
			...run,
			targets: run.targets.map((t) =>
				t.id === "db" ? { ...t, port: t.port + 1 } : t,
			),
		},
		{
			...run,
			targets: run.targets.map((t) =>
				t.id === "db" ? { ...t, protocol: "http" as const } : t,
			),
		},
		{ ...run, endpoint: `${run.endpoint}a` },
	]) {
		await forwards.reconcile(directory(replacement));
		expect(forwards.size).toBe(0);
		expect(created.every((entry) => entry.closed)).toBe(true);
		await forwards.open(run, "db");
	}
	await forwards.close();
});

test("reconciliation closes stopped, revoked and unavailable targets only", async () => {
	const { run, created, forwards } = setup();
	await forwards.open(run, "web");
	await forwards.open({ ...run, sessionId: "other-session" }, "db");
	const stopped = {
		...run,
		targets: run.targets.map((t) =>
			t.id === "web" ? { ...t, status: "stopped" as const } : t,
		),
	};
	await forwards.reconcile(directory(stopped));
	expect(forwards.size).toBe(1);
	expect(created.map((entry) => entry.closed)).toEqual([true, false, true]);
	await expect(forwards.open(stopped, "web")).rejects.toThrow("unavailable");
	await forwards.reconcile(directory({ ...stopped, transport: "connecting" }));
	expect(forwards.size).toBe(0);
	expect(created.every((entry) => entry.closed)).toBe(true);
});

test("reopening a failed local Tailcat client replaces its dead listener", async () => {
	const { run, created, forwards } = setup();
	const first = await forwards.open(run, "db");
	await first.close();
	const replacement = await forwards.open(run, "db");
	expect(replacement).not.toBe(first);
	expect(replacement.closed).toBe(false);
	expect(created).toHaveLength(2);
	expect(forwards.size).toBe(1);
	await forwards.close();
});
