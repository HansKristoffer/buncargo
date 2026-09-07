import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDevArgs } from "../../cli/dev-flags";
import type { RunEntry } from "../run-registry";
import { mappingState, parsePeer, type TailscaleCommand } from "./client";
import { directorySnapshot } from "./directory";
import { createTailnetRuntime } from "./runtime";
import { tailnetServiceDefinition } from "./service";
import {
	allocationPort,
	mutateTailnet,
	readTailnetState,
	tailnetStatePath,
} from "./state";

let home: string;
let prior: string | undefined;
beforeEach(async () => {
	prior = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "buncargo-tailnet-"));
	process.env.HOME = home;
	await mutateTailnet(async (state, save) => {
		state.enabled = true;
		await save();
	});
});
afterEach(() => {
	if (prior === undefined) delete process.env.HOME;
	else process.env.HOME = prior;
	rmSync(home, { recursive: true, force: true });
});
const hostname = "devbox.tail123.ts.net";

function fake() {
	const state: {
		TCP: Record<string, unknown>;
		Web: Record<string, unknown>;
		AllowFunnel: Record<string, boolean>;
	} = { TCP: {}, Web: {}, AllowFunnel: {} };
	const calls: string[][] = [];
	let failPort: number | undefined;
	const command: TailscaleCommand = async (args) => {
		calls.push(args);
		if (args[0] === "status")
			return JSON.stringify({
				BackendState: "Running",
				Self: { ID: "machine", DNSName: `${hostname}.`, Online: true },
			});
		if (args[1] === "status") return JSON.stringify(state);
		const port = Number(
			args.find((a) => a.startsWith("--https="))?.split("=")[1],
		);
		if (port === failPort) throw new Error("permission denied");
		if (args.at(-1) === "off") {
			delete state.TCP[port];
			delete state.Web[`${hostname}:${port}`];
		} else {
			state.TCP[port] = { HTTPS: true };
			state.Web[`${hostname}:${port}`] = {
				Handlers: { "/": { Proxy: args.at(-1) } },
			};
		}

		return "";
	};
	const alive = new Set([123, 456]);
	const runs: RunEntry[] = [];
	return {
		state,
		calls,
		alive,
		runs,
		command,
		fail: (port: number) => {
			failPort = port;
		},
		runtime: createTailnetRuntime({
			command,
			busy: () => false,
			alive: (pid) => alive.has(pid),
			runs: async () => runs,
		}),
	};
}
const input = {
	root: "/checkout/a",
	apps: [{ name: "web", port: 5173, reused: false }],
	pid: 123,
	identity: "birth-a",
};
describe("tailnet mappings", () => {
	it("keeps the external URL when the upstream port changes after restart", async () => {
		const f = fake();
		const first = await f.runtime.acquire(input);
		await f.runtime.release(input.root, 123);
		const second = await f.runtime.acquire({
			...input,
			apps: [{ name: "web", port: 6000, reused: false }],
		});
		expect(second).toEqual(first);
		expect(readTailnetState().allocations[0]?.lease?.upstream).toBe(6000);
	});

	it("reuses a live owner's mapping without giving the second run cleanup rights", async () => {
		const f = fake();
		const first = await f.runtime.acquire(input);
		const second = await f.runtime.acquire({
			...input,
			pid: 456,
			apps: [{ name: "web", port: 5173, reused: true }],
		});
		expect(second).toEqual(first);
		await f.runtime.release(input.root, 456);
		expect(readTailnetState().allocations[0]?.lease?.pid).toBe(123);
		expect(f.calls.filter((a) => a.at(-1) === "off")).toHaveLength(0);
	});

	it("refuses to pretend a reused local app received new environment variables", async () => {
		const f = fake();
		await expect(
			f.runtime.acquire({
				...input,
				apps: [{ name: "web", port: 5173, reused: true }],
			}),
		).rejects.toThrow("--takeover");
	});

	it("skips a Funnel-owned port during allocation", async () => {
		const f = fake();
		const url = (await f.runtime.acquire(input)).web ?? "missing";
		await f.runtime.release(input.root, 123);
		const port = Number(new URL(url).port);
		f.state.AllowFunnel[`${hostname}:${port}`] = true;
		await expect(f.runtime.acquire(input)).rejects.toThrow("occupied");
		expect(f.state.AllowFunnel[`${hostname}:${port}`]).toBe(true);
	});

	it("never removes a mapping changed by another tool", async () => {
		const f = fake();
		const url = (await f.runtime.acquire(input)).web ?? "missing";
		const port = Number(new URL(url).port);
		f.state.Web[`${hostname}:${port}`] = {
			Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } },
		};
		await expect(f.runtime.release(input.root, 123)).rejects.toThrow(
			"refusing to remove",
		);
		expect(f.calls.some((a) => a.at(-1) === "off")).toBe(false);
	});

	it("cleans a crashed owner's mapping but preserves its reservation", async () => {
		const f = fake();
		await f.runtime.acquire(input);
		f.alive.delete(123);
		await f.runtime.reconcile();
		expect(readTailnetState().allocations).toHaveLength(1);
		expect(readTailnetState().allocations[0]?.lease).toBeUndefined();
		expect(Object.keys(f.state.TCP)).toHaveLength(0);
	});

	it("continues crash cleanup when another mapping has a foreign owner", async () => {
		const f = fake();
		const first = await f.runtime.acquire(input);
		await f.runtime.acquire({ ...input, root: "/checkout/b", pid: 456 });
		const port = Number(new URL(first.web ?? "missing").port);
		f.state.Web[`${hostname}:${port}`] = {
			Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } },
		};
		f.alive.clear();
		const { issues } = await f.runtime.reconcile();
		expect(issues).toHaveLength(1);
		expect(Object.keys(f.state.TCP)).toEqual([String(port)]);
		expect(readTailnetState().allocations.filter((a) => a.lease)).toHaveLength(
			1,
		);
	});

	it("restores the installed directory on reconnect, including a custom port", async () => {
		const f = fake();
		await mutateTailnet(async (state, save) => {
			state.enabled = true;
			state.directory = {
				hostname,
				port: 49000,
				target: "http://127.0.0.1:48444",
			};
			await save();
		});
		expect((await f.runtime.reconcile()).issues).toEqual([]);
		expect(
			mappingState(f.state, hostname, 49000, "http://127.0.0.1:48444"),
		).toBe("owned");
	});

	it("does not restore a startup mapping before a live app is registered", async () => {
		const f = fake();
		const urls = await f.runtime.acquire(input);
		const port = Number(new URL(urls.web ?? "missing").port);
		delete f.state.TCP[port];
		delete f.state.Web[`${hostname}:${port}`];
		await f.runtime.reconcile();
		expect(Object.keys(f.state.TCP)).toHaveLength(0);
		expect(readTailnetState().allocations[0]?.lease).toBeDefined();
	});

	it("removes a dead app even while its owning CLI is alive", async () => {
		const f = fake();
		await f.runtime.acquire(input);
		f.runs.push({
			root: input.root,
			pid: 123,
			projectPrefix: "fixture",
			projectName: "fixture",
			worktree: "a",
			startedAt: "now",
			updatedAt: "now",
			hosts: null,
			cli: { program: "bun" },
			services: [],
			apps: [
				{
					name: "web",
					port: 5173,
					url: "local",
					loopbackUrl: "local",
					status: "ready",
					pid: 999,
					processIdentity: "old-birth",
				},
			],
		});
		await f.runtime.reconcile();
		expect(Object.keys(f.state.TCP)).toHaveLength(0);
		expect(readTailnetState().allocations[0]?.lease).toBeUndefined();
	});

	it("rolls back partial multi-app startup", async () => {
		const f = fake();
		const seed = await f.runtime.acquire({
			...input,
			apps: [...input.apps, { name: "api", port: 3000, reused: false }],
		});
		await f.runtime.release(input.root, 123);
		f.fail(Number(new URL(seed.api ?? "missing").port));
		await expect(
			f.runtime.acquire({
				...input,
				apps: [...input.apps, { name: "api", port: 3000, reused: false }],
			}),
		).rejects.toThrow("permission denied");
		expect(Object.keys(f.state.TCP)).toHaveLength(0);
	});

	it("rolls back a mapping applied just before startup cancellation", async () => {
		const f = fake();
		const controller = new AbortController();
		const runtime = createTailnetRuntime({
			command: async (args) => {
				const result = await f.command(args);
				if (args.includes("--yes")) controller.abort(new Error("cancelled"));
				return result;
			},
			alive: () => true,
			busy: () => false,
		});
		await expect(
			runtime.acquire({ ...input, signal: controller.signal }),
		).rejects.toThrow("cancelled");
		expect(Object.keys(f.state.TCP)).toHaveLength(0);
		expect(readTailnetState().allocations[0]?.lease).toBeUndefined();
	});

	it("allocates distinct ports to simultaneous worktrees under a shared lock", async () => {
		const f = fake();
		const [a, b] = await Promise.all([
			f.runtime.acquire(input),
			f.runtime.acquire({ ...input, root: "/checkout/b", pid: 456 }),
		]);
		expect(a.web).not.toBe(b.web);
		expect(readTailnetState().allocations).toHaveLength(2);
	});

	it("fails closed on corrupt persisted ownership", async () => {
		const f = fake();
		await f.runtime.acquire(input);
		writeFileSync(tailnetStatePath(), '{"version":999}');
		await expect(f.runtime.acquire(input)).rejects.toThrow("Invalid or newer");
		expect(readTailnetState).toThrow();
	});
});

it("rejects foreground and path-sharing mapping ownership", () => {
	const target = "http://127.0.0.1:5173";
	expect(
		mappingState(
			{ Foreground: { id: { TCP: { "20000": { HTTPS: true } } } } },
			hostname,
			20000,
			target,
		),
	).toBe("conflict");
	expect(
		mappingState(
			{
				TCP: { "20000": { HTTPS: true } },
				Web: {
					[`${hostname}:20000`]: {
						Handlers: { "/": { Proxy: target }, "/other": { Text: "hi" } },
					},
				},
			},
			hostname,
			20000,
			target,
		),
	).toBe("conflict");
});

it("validates MagicDNS and bounded allocations", () => {
	expect(() => parsePeer({ ID: "id", DNSName: "localhost" })).toThrow();
	const port = allocationPort("workspace", new Set());
	expect(allocationPort("workspace", new Set([port]))).not.toBe(port);
});

it("keeps explicit mode flags unambiguous", () => {
	expect(parseDevArgs(["--tailnet"]).tailnet).toBe(true);
	expect(parseDevArgs(["--no-tailnet"]).tailnet).toBe(false);
	expect(parseDevArgs(["--tailnet", "--no-tailnet"]).errors).toHaveLength(1);
	expect(parseDevArgs(["--tailnet", "--expose=web"]).errors).toHaveLength(1);
});

it("escapes machine paths in service definitions", () => {
	const input = {
		bun: "/a & b/bun",
		script: '/a/"test".js',
		home: "/a",
		log: "/log",
		binary: "/tailscale",
	};
	expect(tailnetServiceDefinition({ ...input, platform: "darwin" })).toContain(
		"&amp;",
	);
	expect(tailnetServiceDefinition({ ...input, platform: "linux" })).toContain(
		'\\"test\\"',
	);
});

it("publishes only explicit remote fields", async () => {
	const f = fake();
	await f.runtime.acquire(input);
	const run = {
		root: input.root,
		pid: 123,
		sessionId: "run",
		projectPrefix: "lullu",
		projectName: "private-name",
		worktree: "tree",
		startedAt: "now",
		updatedAt: "now",
		hosts: null,
		cli: { program: "/secret/executable" },
		apps: [
			{
				name: "web",
				port: 5173,
				url: "http://private",
				loopbackUrl: "http://private",
				status: "ready" as const,
			},
		],
		services: [],
	};
	const result = directorySnapshot(
		{ id: "machine", hostname, online: true },
		readTailnetState(),
		[run],
		f.state,
	);
	const serialized = JSON.stringify(result);
	expect(result.runs).toHaveLength(1);
	expect(serialized).not.toContain("private");
	expect(serialized).not.toContain(input.root);
	expect(serialized).not.toContain("executable");
});

it("continues release after a conflict and never restores pending removals", async () => {
	const f = fake();
	const urls = await f.runtime.acquire({
		...input,
		apps: [...input.apps, { name: "api", port: 3000, reused: false }],
	});
	const web = Number(new URL(urls.web as string).port),
		api = Number(new URL(urls.api as string).port);
	f.state.Web[`${hostname}:${web}`] = {
		Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } },
	};
	await expect(f.runtime.release(input.root, 123)).rejects.toThrow(
		"Pending tailnet cleanup",
	);
	expect(f.state.TCP[api]).toBeUndefined();
	expect(
		readTailnetState().allocations.find((a) => a.port === web)?.lease
			?.pendingRemoval,
	).toBe(true);
	delete f.state.TCP[web];
	delete f.state.Web[`${hostname}:${web}`];
	await f.runtime.reconcile();
	expect(f.state.TCP[web]).toBeUndefined();
	expect(readTailnetState().allocations.every((a) => !a.lease)).toBe(true);
});
it("cleans disabled mappings even if their owner remains alive", async () => {
	const f = fake();
	await f.runtime.acquire(input);
	await mutateTailnet(async (state, save) => {
		state.enabled = false;
		state.removing = true;
		await save();
	});
	await f.runtime.reconcile();
	expect(Object.keys(f.state.TCP)).toHaveLength(0);
	expect(readTailnetState().allocations[0]?.lease).toBeUndefined();
	await expect(f.runtime.acquire(input)).rejects.toThrow(
		"uninstall is pending",
	);
});
it("reads Serve once for a warm multi-app reconciliation", async () => {
	const f = fake();
	await f.runtime.acquire({
		...input,
		apps: [...input.apps, { name: "api", port: 3000, reused: false }],
	});
	f.runs.push({
		root: input.root,
		pid: 123,
		worktree: null,
		projectPrefix: "demo",
		projectName: "demo",
		startedAt: "now",
		updatedAt: "now",
		hosts: null,
		cli: { program: "bun" },
		services: [],
		apps: ["web", "api"].map((name) => ({
			name,
			pid: 456,
			status: "ready",
			port: name === "web" ? 5173 : 3000,
			url: "local",
			loopbackUrl: "local",
		})),
	});
	f.calls.length = 0;
	await f.runtime.reconcile();
	expect(f.calls).toEqual([
		["status", "--json"],
		["serve", "status", "--json"],
	]);
});
it("does not associate a lease with a different session or process birth", async () => {
	const f = fake();
	await f.runtime.acquire({ ...input, sessionId: "owner" });
	const allocation = readTailnetState().allocations[0];
	expect(allocation?.lease?.sessionId).toBe("owner");
	const run: RunEntry = {
		root: input.root,
		pid: 123,
		sessionId: "other",
		processIdentity: "birth-a",
		worktree: null,
		projectPrefix: "demo",
		projectName: "demo",
		startedAt: "now",
		updatedAt: "now",
		hosts: null,
		cli: { program: "bun" },
		services: [],
		apps: [
			{
				name: "web",
				port: 5173,
				status: "ready",
				url: "local",
				loopbackUrl: "local",
			},
		],
	};
	expect(
		directorySnapshot(
			{ id: "machine", hostname, online: true },
			readTailnetState(),
			[run],
			f.state,
		).runs,
	).toHaveLength(0);
	run.sessionId = "owner";
	run.processIdentity = "different-birth";
	expect(
		directorySnapshot(
			{ id: "machine", hostname, online: true },
			readTailnetState(),
			[run],
			f.state,
		).runs,
	).toHaveLength(0);
});

it("migrates v1 state without losing ports and persists cleanup intent in v2", async () => {
	const f = fake();
	await f.runtime.acquire(input);
	const state = readTailnetState();
	writeFileSync(tailnetStatePath(), JSON.stringify({ ...state, version: 1 }));
	expect(readTailnetState().allocations[0]?.port).toBe(
		state.allocations[0]?.port,
	);
	await f.runtime.release(input.root, 123);
	expect(readTailnetState().version).toBe(2);
});

it("cancels a reconciliation waiting on the machine lock without mutating", async () => {
	const f = fake();
	let release!: () => void;
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	let locked!: () => void;
	const entered = new Promise<void>((resolve) => {
		locked = resolve;
	});
	const owner = mutateTailnet(async () => {
		locked();
		await hold;
	});
	await entered;
	try {
		await expect(
			f.runtime.reconcile(AbortSignal.timeout(30)),
		).rejects.toThrow();
		expect(f.calls).toHaveLength(0);
	} finally {
		release();
		await owner;
	}
});
