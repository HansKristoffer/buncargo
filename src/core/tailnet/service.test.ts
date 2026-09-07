import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceTailnetAgent } from "./agent";
import type { TailscaleCommand } from "./client";
import { createTailnetRefresh } from "./daemon";
import { tailnetDiagnostics } from "./diagnostics";
import {
	installTailnet,
	uninstallTailnet,
	verifyTailnetDirectory,
} from "./service";
import { mutateTailnet, readTailnetState } from "./state";

let previous: string | undefined;

let home: string;

beforeEach(() => {
	previous = process.env.HOME;
	home = mkdtempSync(join(tmpdir(), "buncargo-tailnet-service-"));
	process.env.HOME = home;
});

afterEach(() => {
	if (previous === undefined) delete process.env.HOME;
	else process.env.HOME = previous;

	rmSync(home, { recursive: true, force: true });
});

const hostname = "devbox.tail123.ts.net";

function fixture() {
	const actual: { TCP: Record<string, unknown>; Web: Record<string, unknown> } =
		{ TCP: {}, Web: {} };

	const actions: string[] = [];

	const command: TailscaleCommand = async (args) => {
		if (args[0] === "status")
			return JSON.stringify({
				BackendState: "Running",
				Self: { ID: "machine", DNSName: hostname },
			});

		if (args[1] === "status") return JSON.stringify(actual);

		const port = Number(
			args.find((a) => a.startsWith("--https="))?.split("=")[1],
		);

		actions.push(`${port}:${args.at(-1)}`);

		if (args.at(-1) === "off") {
			delete actual.TCP[port];
			delete actual.Web[`${hostname}:${port}`];
		} else {
			actual.TCP[port] = { HTTPS: true };
			actual.Web[`${hostname}:${port}`] = {
				Handlers: { "/": { Proxy: args.at(-1) } },
			};
		}

		return "";
	};

	const deps = {
		command: () => ({ binary: "/fixture/tailscale", ts: command }),
		installAgent: async () => {
			actions.push("install");
		},
		verify: async () => {
			actions.push("verify");
		},
	};

	return { actual, actions, command, deps };
}

it("preflights a foreign directory before replacing an agent", async () => {
	const f = fixture();

	f.actual.TCP[48443] = { TCPForward: "127.0.0.1:9999" };
	await expect(installTailnet(48443, f.deps)).rejects.toThrow("already owned");
	expect(f.actions).toEqual([]);
});

it("preflights a port change and rechecks ownership after agent installation", async () => {
	const f = fixture();

	await mutateTailnet(async (state, save) => {
		state.directory = {
			hostname,
			port: 49000,
			target: "http://127.0.0.1:48444",
		};
		await save();
	});
	await expect(installTailnet(48443, f.deps)).rejects.toThrow(
		"before changing",
	);
	expect(f.actions).toEqual([]);
	await expect(
		installTailnet(49000, {
			...f.deps,
			installAgent: async () => {
				f.actual.TCP[49000] = { TCPForward: "foreign" };
			},
		}),
	).rejects.toThrow("already owned");
	expect(f.actions).toEqual([]);
});

it("serializes install and uninstall through service completion", async () => {
	const f = fixture();
	let enter!: () => void;

	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});

	let release!: () => void;

	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});

	const install = installTailnet(48443, {
		...f.deps,
		installAgent: async () => {
			enter();
			await hold;
			f.actions.push("install");
		},
	});

	await entered;

	const uninstall = uninstallTailnet({
		command: f.command,
		removeAgent: async () => {
			f.actions.push("remove");
		},
	});

	release();
	await Promise.all([install, uninstall]);
	expect(f.actions.indexOf("remove")).toBeGreaterThan(
		f.actions.indexOf("verify"),
	);
	expect(readTailnetState().enabled).toBe(false);
	expect(readTailnetState().directory).toBeUndefined();
});

it("retains uninstall intent and the coordinator until conflicts are resolved", async () => {
	const f = fixture();

	await installTailnet(48443, f.deps);
	f.actual.Web[`${hostname}:48443`] = {
		Handlers: { "/": { Proxy: "foreign" } },
	};

	let removed = false;

	await expect(
		uninstallTailnet({
			command: f.command,
			removeAgent: async () => {
				removed = true;
			},
		}),
	).rejects.toThrow("remains installed");
	expect(removed).toBe(false);
	expect(readTailnetState().removing).toBe(true);
	expect(readTailnetState().enabled).toBe(false);
});

it("restores a working definition on replacement failure and removes a failed first installation", async () => {
	for (const previous of ["old definition", undefined]) {
		let definition = previous;
		const started: (string | undefined)[] = [];

		await expect(
			replaceTailnetAgent("new definition", "new-hash", {
				read: async () => definition,
				write: async (value) => {
					definition = value;
				},
				remove: async () => {
					definition = undefined;
				},
				stop: async () => {},
				start: async () => {
					started.push(definition);

					if (definition === "new definition") throw new Error("load failed");
				},
				healthy: async () => false,
				sleep: async () => {},
			}),
		).rejects.toThrow("load failed");
		expect(definition).toBe(previous);

		if (previous) expect(started).toEqual(["new definition", "old definition"]);
	}
});

it("does not accept another bundle's health during replacement", async () => {
	let definition: string | undefined = "old";

	await expect(
		replaceTailnetAgent("new", "expected", {
			read: async () => definition,
			write: async (value) => {
				definition = value;
			},
			remove: async () => {
				definition = undefined;
			},
			stop: async () => {},
			start: async () => {},
			healthy: async (hash) => hash === "old",
			sleep: async () => {},
		}),
	).rejects.toThrow("did not start");
	expect(definition).toBe("old");
});

it("reports persisted state and stale bundles when Tailscale is disconnected", async () => {
	const result = await tailnetDiagnostics(
		async () => {
			throw new Error("disconnected");
		},
		{
			health: async () => ({
				service: "buncargo-tailnet",
				version: 1,
				ready: false,
				bundleHash: "old",
				issues: ["reconciliation failed"],
			}),
			installed: async () => undefined,
			bundle: async () => ({ contents: "new", hash: "new", version: "1" }),
		},
	);

	expect(result.enabled).toBe(false);
	expect(result.hostname).toBeNull();
	expect(result.stale).toBe(true);
	expect(result.issues.join(" ")).toContain("disconnected");
});

it("reports live HTTP health separately from failed reconciliation and throttles logs", async () => {
	const logs: string[] = [];

	const refresh = createTailnetRefresh(
		{
			reconcile: async () => {
				throw new Error("private diagnostic");
			},
		},
		"hash",
		{
			now: () => 0,
			log: (s) => {
				logs.push(s);
			},
		},
	);

	await refresh.refresh(new AbortController().signal);
	await refresh.refresh(new AbortController().signal);
	expect(refresh.health.ready).toBe(false);
	expect(refresh.health.bundleHash).toBe("hash");
	expect(refresh.health.lastSuccess).toBeUndefined();
	expect(refresh.snapshot()).toBeUndefined();
	expect(logs).toHaveLength(1);
	expect(JSON.stringify(refresh.health)).not.toContain("private diagnostic");
});

it("waits for the first directory snapshot but rejects a different identity", async () => {
	let calls = 0;

	const request = async () =>
		++calls === 1
			? new Response("unavailable", { status: 503 })
			: Response.json({ version: 1, machineId: "machine", hostname });

	await verifyTailnetDirectory(`https://${hostname}:48443`, "machine", request);
	expect(calls).toBe(2);
	await expect(
		verifyTailnetDirectory(`https://${hostname}:48443`, "different", request),
	).rejects.toThrow("identity");
});
