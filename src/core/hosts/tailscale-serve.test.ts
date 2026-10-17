import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTailscaleServePath } from "./paths";
import type { ServeConfig, TailscaleCommandResult } from "./tailscale-cli";
import {
	activateTailscaleServe,
	diagnoseTailscaleHosts,
	loadTailscaleServeEntries,
	planServeChanges,
	readServedTailscaleUrls,
	releaseTailscaleServe,
	servedTailscaleUrls,
	sweepTailscaleServe,
	type TailscaleServeDeps,
	type TailscaleServeEntry,
	tailscaleBlockPorts,
	tailscaleHttpsPort,
} from "./tailscale-serve";

const HOST = "box.tail1234.ts.net";
const ADDRESS = "100.64.0.9";
const ROOT = "/work/app";
// This process, so readers that ask the real `kill(pid, 0)` see it alive.
const SELF = process.pid;
const OTHER = 5151;
const DEAD = 9191;

// The serve state file lives in ~/.buncargo: never the developer's.
const savedHome = process.env.HOME;
let home = "";
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-tailscale-home-"));
	process.env.HOME = home;
});
afterEach(() => {
	process.env.HOME = savedHome;
	rmSync(home, { recursive: true, force: true });
});

const ok = (stdout = ""): TailscaleCommandResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
});
const fail = (stderr: string): TailscaleCommandResult => ({
	exitCode: 1,
	stdout: "",
	stderr,
});

const runningStatus = JSON.stringify({
	BackendState: "Running",
	CertDomains: [HOST],
	Self: { DNSName: `${HOST}.`, TailscaleIPs: [ADDRESS, "fd7a::9"] },
});

/**
 * A stand-in for `tailscale`: its serve config as the real one prints it,
 * with the machine's own entry on :443 that buncargo must never touch, and
 * every command it was asked to run.
 */
function fakeTailscale(
	options: {
		status?: TailscaleCommandResult;
		/** Answer the next serve changes with these instead of applying them. */
		refusals?: TailscaleCommandResult[];
	} = {},
) {
	const web: Record<string, { Handlers: Record<string, { Proxy: string }> }> = {
		[`${HOST}:443`]: {
			Handlers: {
				"/": { Proxy: "http://127.0.0.1:3773" },
				"/health": { Proxy: "http://127.0.0.1:7979" },
			},
		},
	};
	const tcp: Record<string, { HTTPS: boolean }> = { "443": { HTTPS: true } };
	const calls: string[] = [];
	const refusals = [...(options.refusals ?? [])];
	const cli = async (args: readonly string[]) => {
		calls.push(args.join(" "));
		const [command, ...rest] = args;
		if (command === "status") return options.status ?? ok(runningStatus);
		if (command === "debug") return ok(JSON.stringify({ OperatorUser: "dev" }));
		if (rest[0] === "status") return ok(JSON.stringify({ TCP: tcp, Web: web }));
		const refusal = refusals.shift();
		if (refusal) return refusal;
		const port = (rest.find((arg) => arg.startsWith("--https=")) ?? "").slice(
			"--https=".length,
		);
		if (rest.at(-1) === "off") {
			if (!web[`${HOST}:${port}`])
				return fail(
					"error: failed to remove web serve: handler does not exist",
				);
			delete web[`${HOST}:${port}`];
			delete tcp[port];
			return ok();
		}
		web[`${HOST}:${port}`] = {
			Handlers: { "/": { Proxy: rest.at(-1) as string } },
		};
		tcp[port] = { HTTPS: true };
		return ok();
	};
	const changes = () => calls.filter((call) => call.startsWith("serve --"));
	return { cli, calls, web, changes };
}

function deps(
	cli: TailscaleServeDeps["cli"],
	options: { probe?: TailscaleServeDeps["probe"]; alive?: number[] } = {},
): TailscaleServeDeps {
	const alive = new Set(options.alive ?? [SELF, OTHER]);
	return {
		cli,
		probe: options.probe ?? (async () => undefined),
		isAlive: (pid) => alive.has(pid),
	};
}

const entry = (
	overrides: Partial<TailscaleServeEntry> = {},
): TailscaleServeEntry => ({
	root: ROOT,
	app: "web",
	pid: SELF,
	httpsPort: 25173,
	target: "http://127.0.0.1:5173",
	hostname: HOST,
	...overrides,
});

const configOf = (...entries: TailscaleServeEntry[]): ServeConfig =>
	new Map(
		entries.map((item) => [
			item.httpsPort,
			{ hostname: item.hostname, target: item.target },
		]),
	);

function plan(input: {
	entries?: TailscaleServeEntry[];
	config?: ServeConfig;
	takeover?: string[];
}) {
	const alive = new Set([SELF, OTHER]);
	return planServeChanges({
		entries: input.entries ?? [],
		config: input.config ?? new Map(),
		root: ROOT,
		pid: SELF,
		hostname: HOST,
		wants: [{ app: "web", httpsPort: 25173, target: "http://127.0.0.1:5173" }],
		takeover: new Set(input.takeover),
		isAlive: (pid) => alive.has(pid),
	});
}

const recordedApps = async () =>
	(await loadTailscaleServeEntries()).map((item) => item.app);

describe("tailscaleHttpsPort", () => {
	it("serves an app on its port plus 20000, and not past 65535", () => {
		expect(tailscaleHttpsPort(5173)).toBe(25173);
		expect(tailscaleHttpsPort(45535)).toBe(65535);
		expect(tailscaleHttpsPort(45536)).toBeUndefined();
	});
});

describe("tailscaleBlockPorts", () => {
	it("adds each app's HTTPS port to the block in tailscale mode only", () => {
		const ports = { web: 5273, api: 3110, postgres: 5532 };
		const appNames = ["web", "api"];
		const companions = tailscaleBlockPorts({
			mode: "tailscale",
			hosts: true,
			appNames,
		});
		expect(companions?.(ports)).toEqual([25273, 23110]);
		expect(
			tailscaleBlockPorts({ mode: "loopback", hosts: true, appNames }),
		).toBeUndefined();
		expect(
			tailscaleBlockPorts({ mode: "tailscale", hosts: false, appNames }),
		).toBeUndefined();
	});
});

describe("planServeChanges", () => {
	it("adds what is wanted on a free port", () => {
		const result = plan({});
		expect(result.register.map((item) => [item.app, item.pid])).toEqual([
			["web", SELF],
		]);
		expect(result.off).toEqual([]);
		expect(result.refused).toEqual([]);
	});

	it("never touches a port whose entry buncargo did not record", () => {
		const result = plan({ config: new Map([[25173, "other"]]) });
		expect(result.register).toEqual([]);
		expect(result.off).toEqual([]);
		expect(result.refused[0]).toContain("tailscale serve --https=25173 off");
	});

	it("names the run holding the port when it is another checkout's recorded entry", () => {
		const holder = entry({ root: "/work/other", app: "admin", pid: OTHER });
		const result = plan({ entries: [holder], config: configOf(holder) });
		expect(result.register).toEqual([]);
		expect(result.refused[0]).toContain(
			`admin of /work/other for run pid ${OTHER}`,
		);
	});

	it("takes out an ended run's entry, and only when Tailscale still has it as recorded", () => {
		const ended = entry({
			root: "/work/other",
			app: "api",
			httpsPort: 23000,
			pid: DEAD,
		});
		const changed = entry({
			root: "/work/other",
			app: "admin",
			httpsPort: 23001,
			pid: DEAD,
		});
		const result = plan({
			entries: [ended, changed],
			config: new Map([
				[23000, { hostname: HOST, target: ended.target }],
				[23001, { hostname: HOST, target: "http://127.0.0.1:9999" }],
			]),
		});
		expect(result.off).toEqual([ended]);
		expect(result.records.map((item) => item.app)).toEqual(["web"]);
	});

	it("leaves an entry another live run of the checkout serves with that run, unless taken over", () => {
		const theirs = entry({ pid: OTHER, servedAt: "2026-10-17T00:00:01Z" });
		const kept = plan({ entries: [theirs], config: configOf(theirs) });
		expect(kept.register).toEqual([]);
		expect(kept.serving.map((item) => item.pid)).toEqual([OTHER]);

		const taken = plan({
			entries: [theirs],
			config: configOf(theirs),
			takeover: ["web"],
		});
		expect(taken.register).toEqual([]);
		expect(taken.records.map((item) => item.pid)).toEqual([SELF]);
	});

	it("adopts its own crashed run's entry without a command, and probes it afresh", () => {
		const crashed = entry({ pid: DEAD, servedAt: "2026-10-17T00:00:01Z" });
		const result = plan({ entries: [crashed], config: configOf(crashed) });
		expect(result.off).toEqual([]);
		expect(result.register).toEqual([]);
		expect(result.serving).toEqual([
			{ ...crashed, pid: SELF, servedAt: undefined },
		]);
	});

	it("takes out its own entry for a port the app no longer has", () => {
		const old = entry({ httpsPort: 25073, target: "http://127.0.0.1:5073" });
		const result = plan({ entries: [old], config: configOf(old) });
		expect(result.off).toEqual([old]);
		expect(result.register.map((item) => item.httpsPort)).toEqual([25173]);
	});

	it("adds a recorded entry again once Tailscale has lost it", () => {
		const lost = entry({ servedAt: "2026-10-17T00:00:01Z" });
		const result = plan({ entries: [lost] });
		expect(result.register).toEqual([{ ...lost, servedAt: undefined }]);
	});

	it("keeps other checkouts' live entries as they are", () => {
		const other = entry({
			root: "/work/other",
			app: "api",
			httpsPort: 23000,
			pid: OTHER,
		});
		const result = plan({ entries: [other], config: configOf(other) });
		expect(result.records).toContainEqual(other);
		expect(result.off).toEqual([]);
	});
});

describe("activateTailscaleServe", () => {
	const apps = [
		{ name: "web", port: 5173 },
		{ name: "api", port: 3010 },
	];
	const activate = (
		cli: TailscaleServeDeps["cli"],
		options: Parameters<typeof deps>[1] = {},
	) =>
		activateTailscaleServe(
			{
				root: ROOT,
				pid: SELF,
				apps,
				blockPorts: [5173, 3010, 5433],
				takeover: new Set(),
			},
			deps(cli, options),
		);

	it("serves each app on its HTTPS port, records it and advertises what answered", async () => {
		const tailscale = fakeTailscale();
		const probed: string[] = [];
		const result = await activate(tailscale.cli, {
			probe: async (target) => {
				probed.push(`${target.address} ${target.hostname}:${target.httpsPort}`);
				return undefined;
			},
		});

		expect(tailscale.changes()).toEqual([
			"serve --bg --https=25173 http://127.0.0.1:5173",
			"serve --bg --https=23010 http://127.0.0.1:3010",
		]);
		expect(result).toEqual({
			urls: { web: `https://${HOST}:25173`, api: `https://${HOST}:23010` },
			fallbacks: [],
			notes: [],
		});
		// By address, asking for the name: no DNS lookup of our own name.
		expect(probed.sort()).toEqual([
			`${ADDRESS} ${HOST}:23010`,
			`${ADDRESS} ${HOST}:25173`,
		]);
		const recorded = await loadTailscaleServeEntries();
		expect(
			recorded.map((item) => [item.app, item.pid, item.httpsPort]),
		).toEqual([
			["web", SELF, 25173],
			["api", SELF, 23010],
		]);
		expect(recorded.every((item) => item.servedAt !== undefined)).toBe(true);
		// The machine's own entry on :443 is untouched.
		expect(Object.keys(tailscale.web[`${HOST}:443`]?.Handlers ?? {})).toEqual([
			"/",
			"/health",
		]);
	});

	it("keeps the plain URL of an app Tailscale does not answer for, and says why", async () => {
		const tailscale = fakeTailscale();
		const result = await activate(tailscale.cli, {
			probe: async (target) =>
				target.httpsPort === 23010 ? "ECONNREFUSED" : undefined,
		});
		expect(Object.keys(result.urls)).toEqual(["web"]);
		expect(result.fallbacks).toEqual([expect.stringContaining("ECONNREFUSED")]);
		expect(
			await readServedTailscaleUrls(ROOT, { web: 5173, api: 3010 }),
		).toEqual({ web: `https://${HOST}:25173` });
	});

	it("falls back with one reason when Tailscale cannot serve HTTPS, changing nothing", async () => {
		const tailscale = fakeTailscale({
			status: ok(JSON.stringify({ BackendState: "NeedsLogin" })),
		});
		const result = await activate(tailscale.cli);
		expect(result.urls).toEqual({});
		expect(result.fallbacks).toEqual([
			expect.stringContaining("`tailscale up`"),
		]);
		expect(tailscale.changes()).toEqual([]);
		expect(await loadTailscaleServeEntries()).toEqual([]);
	});

	it("falls back with one reason when there is no tailscale to run", async () => {
		const result = await activate(async () => {
			throw new Error("the tailscale CLI is not installed");
		});
		expect(result.urls).toEqual({});
		expect(result.fallbacks).toEqual([
			expect.stringContaining("the tailscale CLI is not installed"),
		]);
	});

	it("retries a change another writer raced", async () => {
		const tailscale = fakeTailscale({
			refusals: [
				fail("sending serve config: Preconditions failed: etag mismatch"),
			],
		});
		const result = await activate(tailscale.cli);
		expect(tailscale.changes()).toEqual([
			"serve --bg --https=25173 http://127.0.0.1:5173",
			"serve --bg --https=25173 http://127.0.0.1:5173",
			"serve --bg --https=23010 http://127.0.0.1:3010",
		]);
		expect(Object.keys(result.urls).sort()).toEqual(["api", "web"]);
	});

	it("stops at a permission refusal and names every app it left out, once", async () => {
		const tailscale = fakeTailscale({
			refusals: [fail("Access denied: serve config denied")],
		});
		const result = await activate(tailscale.cli);
		expect(tailscale.changes()).toEqual([
			"serve --bg --https=25173 http://127.0.0.1:5173",
		]);
		expect(result.urls).toEqual({});
		expect(result.fallbacks).toEqual([
			expect.stringMatching(/serve web, api .*tailscale set --operator/),
		]);
	});

	it("keeps a refused change recorded, since one that timed out may have applied", async () => {
		const tailscale = fakeTailscale({
			refusals: [fail("context deadline exceeded")],
		});
		await activate(tailscale.cli);
		const recorded = await loadTailscaleServeEntries();
		expect(recorded.map((item) => [item.app, item.servedAt])).toEqual([
			["web", undefined],
			["api", expect.any(String)],
		]);
		// Released with its run, and never advertised meanwhile.
		expect(
			await readServedTailscaleUrls(ROOT, { web: 5173, api: 3010 }),
		).toEqual({ api: `https://${HOST}:23010` });
	});

	it("does not stamp another live run's entry for the same app as answered", async () => {
		const tailscale = fakeTailscale();
		// Another run of this checkout serves web's previous port.
		await activateTailscaleServe(
			{
				root: ROOT,
				pid: OTHER,
				apps: [{ name: "web", port: 5073 }],
				blockPorts: [],
				takeover: new Set(),
			},
			deps(tailscale.cli, { probe: async () => "ECONNREFUSED" }),
		);
		await activate(tailscale.cli);
		const old = (await loadTailscaleServeEntries()).find(
			(item) => item.httpsPort === 25073,
		);
		expect(old?.pid).toBe(OTHER);
		expect(old?.servedAt).toBeUndefined();
	});

	it("skips an app whose HTTPS port would be another port of the block", async () => {
		const tailscale = fakeTailscale();
		const result = await activateTailscaleServe(
			{
				root: ROOT,
				pid: SELF,
				apps: [{ name: "web", port: 5173 }],
				blockPorts: [5173, 25173],
				takeover: new Set(),
			},
			deps(tailscale.cli),
		);
		expect(result.urls).toEqual({});
		expect(result.fallbacks[0]).toContain("port 25173 is another port");
		expect(tailscale.calls).toEqual([]);
	});
});

describe("releaseTailscaleServe and sweepTailscaleServe", () => {
	async function serveTwoRuns() {
		const tailscale = fakeTailscale();
		const ours = { blockPorts: [], takeover: new Set<string>() };
		await activateTailscaleServe(
			{ ...ours, root: ROOT, pid: SELF, apps: [{ name: "web", port: 5173 }] },
			deps(tailscale.cli),
		);
		await activateTailscaleServe(
			{
				...ours,
				root: "/work/other",
				pid: OTHER,
				apps: [{ name: "api", port: 3010 }],
			},
			deps(tailscale.cli),
		);
		tailscale.calls.length = 0;
		return tailscale;
	}

	it("removes only the entries the ending run owns", async () => {
		const tailscale = await serveTwoRuns();
		expect(
			await releaseTailscaleServe(
				{ root: ROOT, pid: SELF },
				deps(tailscale.cli),
			),
		).toEqual([]);
		expect(tailscale.changes()).toEqual(["serve --https=25173 off"]);
		expect(await recordedApps()).toEqual(["api"]);
		expect(tailscale.web[`${HOST}:443`]).toBeDefined();
	});

	it("forgets an entry that changed outside buncargo without touching it", async () => {
		const tailscale = await serveTwoRuns();
		tailscale.web[`${HOST}:25173`] = {
			Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } },
		};
		await releaseTailscaleServe({ root: ROOT, pid: SELF }, deps(tailscale.cli));
		expect(tailscale.changes()).toEqual([]);
		expect(tailscale.web[`${HOST}:25173`]).toBeDefined();
		expect(await recordedApps()).toEqual(["api"]);
	});

	it("sweeps the entries of runs that ended, and runs nothing when none did", async () => {
		const tailscale = await serveTwoRuns();
		expect(await sweepTailscaleServe(deps(tailscale.cli))).toEqual({
			removed: [],
			failures: [],
		});
		expect(tailscale.calls).toEqual([]);

		const swept = await sweepTailscaleServe(
			deps(tailscale.cli, { alive: [SELF] }),
		);
		expect(swept.removed).toEqual([
			expect.stringContaining(`https://${HOST}:23010 (api, /work/other)`),
		]);
		expect(tailscale.changes()).toEqual(["serve --https=23010 off"]);
		expect(await recordedApps()).toEqual(["web"]);
	});

	it("takes no lock on a machine that never served anything", async () => {
		// The watchdog sweeps every pass on every machine.
		const tailscale = fakeTailscale();
		await sweepTailscaleServe(deps(tailscale.cli));
		expect(existsSync(`${getTailscaleServePath()}.lock.v2`)).toBe(false);
		expect(tailscale.calls).toEqual([]);
	});

	it("keeps an entry it could not remove, for the next pass", async () => {
		const tailscale = await serveTwoRuns();
		const failing: TailscaleServeDeps["cli"] = async (args) =>
			args.includes("off")
				? fail("tailscaled is restarting")
				: tailscale.cli(args);
		const swept = await sweepTailscaleServe(deps(failing, { alive: [SELF] }));
		expect(swept.removed).toEqual([]);
		expect(swept.failures[0]).toContain("tailscale serve --https=23010 off");
		expect(await recordedApps()).toEqual(["web", "api"]);
	});
});

describe("servedTailscaleUrls", () => {
	it("advertises only answered entries of this checkout's live runs at the current port", () => {
		const served = "2026-10-17T00:00:01Z";
		const urls = servedTailscaleUrls(
			[
				entry({ servedAt: served }),
				entry({
					app: "api",
					httpsPort: 23010,
					target: "http://127.0.0.1:3010",
				}),
				entry({
					app: "admin",
					httpsPort: 24000,
					target: "http://127.0.0.1:4000",
					servedAt: served,
					pid: DEAD,
				}),
				entry({
					app: "docs",
					httpsPort: 24100,
					target: "http://127.0.0.1:4100",
					servedAt: served,
				}),
				entry({ root: "/work/other", app: "site", servedAt: served }),
			],
			{
				root: ROOT,
				ports: { web: 5173, api: 3010, admin: 4000, docs: 4200 },
				isAlive: (pid) => pid !== DEAD,
			},
		);
		expect(urls).toEqual({ web: `https://${HOST}:25173` });
	});
});

describe("diagnoseTailscaleHosts", () => {
	const user = { name: "dev", uid: 1000, platform: "linux" as const };

	it("reports Tailscale, Serve permission, and recorded entries that are gone or silent", async () => {
		const tailscale = fakeTailscale();
		await activateTailscaleServe(
			{
				root: ROOT,
				pid: SELF,
				apps: [
					{ name: "web", port: 5173 },
					{ name: "api", port: 3010 },
				],
				blockPorts: [],
				takeover: new Set(),
			},
			deps(tailscale.cli),
		);
		delete tailscale.web[`${HOST}:25173`];
		const diagnosis = await diagnoseTailscaleHosts(
			deps(tailscale.cli, { probe: async () => "ECONNREFUSED" }),
			user,
		);
		expect(diagnosis.notes).toContain(
			`Tailscale is up as ${HOST}, with an HTTPS certificate`,
		);
		expect(diagnosis.notes).toContain(
			"dev is Tailscale's operator and may change Serve",
		);
		expect(diagnosis.issues).toEqual([
			expect.stringContaining(`Tailscale is not serving https://${HOST}:25173`),
			expect.stringContaining(
				`https://${HOST}:23010 (api, ${ROOT}) is in the Tailscale Serve config but no TLS handshake succeeds there (ECONNREFUSED)`,
			),
		]);
	});

	it("stops at Tailscale being unreachable", async () => {
		const tailscale = fakeTailscale({
			status: fail("tailscaled is not running"),
		});
		const diagnosis = await diagnoseTailscaleHosts(deps(tailscale.cli), user);
		expect(diagnosis.issues).toEqual([
			expect.stringContaining("tailscaled is not running"),
		]);
	});
});
