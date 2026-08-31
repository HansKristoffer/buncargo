import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createHostsReloader,
	createThrottledFailureLog,
	DAEMON_START_TIMEOUT_MS,
	type HostsReloaderDeps,
	nextReloadDelayMs,
	resolveInstalledServiceWaitMs,
	SERVICE_START_TIMEOUT_MS,
	waitForDaemonHealthy,
	waitForDaemonRoutes,
	writeDaemonConfig,
} from "./daemon";
import { type LocalProxy, startLocalProxy } from "./proxy";

describe("nextReloadDelayMs", () => {
	it("polls every second while reloads succeed", () => {
		expect(nextReloadDelayMs(0)).toBe(1000);
		expect(nextReloadDelayMs(-1)).toBe(1000);
	});

	it("backs off exponentially so a failing daemon does not spin", () => {
		expect(nextReloadDelayMs(1)).toBe(1000);
		expect(nextReloadDelayMs(2)).toBe(2000);
		expect(nextReloadDelayMs(3)).toBe(4000);
	});

	it("caps the backoff so recovery is still noticed", () => {
		expect(nextReloadDelayMs(50)).toBe(30_000);
	});
});

describe("createThrottledFailureLog", () => {
	function harness(intervalMs = 1000) {
		const lines: string[] = [];
		let now = 0;
		const log = createThrottledFailureLog({
			log: (message) => lines.push(message),
			now: () => now,
			intervalMs,
		});
		return {
			lines,
			log,
			advance: (ms: number) => {
				now += ms;
			},
		};
	}

	it("reports the first failure immediately", () => {
		const { lines, log } = harness();
		log.report("reload failed: a");
		expect(lines).toEqual(["reload failed: a"]);
	});

	// The point of the throttle: a certificate gap names the hostnames it is
	// missing, so identical-message filtering alone lets every route change
	// through.
	it("suppresses distinct causes inside the interval", () => {
		const { lines, log, advance } = harness();
		log.report("reload failed: missing a");
		advance(100);
		log.report("reload failed: missing a, b");
		advance(100);
		log.report("reload failed: missing a, b, c");
		expect(lines).toEqual(["reload failed: missing a"]);
	});

	it("reports again after the interval and counts what it dropped", () => {
		const { lines, log, advance } = harness();
		log.report("reload failed: a");
		advance(400);
		log.report("reload failed: a");
		advance(400);
		log.report("reload failed: a");
		advance(400);
		log.report("reload failed: a");
		expect(lines).toEqual([
			"reload failed: a",
			"reload failed: a (2 further failures suppressed)",
		]);
	});

	it("singularizes a single suppressed failure", () => {
		const { lines, log, advance } = harness();
		log.report("reload failed: a");
		advance(500);
		log.report("reload failed: a");
		advance(600);
		log.report("reload failed: a");
		expect(lines[1]).toBe("reload failed: a (1 further failure suppressed)");
	});

	// A recovery is a state change worth seeing straight away, so the next
	// failure must not be swallowed by the interval the old one started.
	it("reports the next failure immediately after a reset", () => {
		const { lines, log, advance } = harness();
		log.report("reload failed: a");
		advance(10);
		log.reset();
		log.report("reload failed: b");
		expect(lines).toEqual(["reload failed: a", "reload failed: b"]);
	});
});

describe("start timeouts", () => {
	it("gives launchd/systemd longer than a self-spawned daemon", () => {
		expect(SERVICE_START_TIMEOUT_MS).toBeGreaterThan(DAEMON_START_TIMEOUT_MS);
	});

	it("does not inherit the launchd cold-start budget on a routine probe", () => {
		expect(resolveInstalledServiceWaitMs()).toBe(0);
		expect(resolveInstalledServiceWaitMs(undefined)).toBe(0);
	});

	it("keeps the cold-start budget after a fresh install", () => {
		expect(resolveInstalledServiceWaitMs(SERVICE_START_TIMEOUT_MS)).toBe(
			SERVICE_START_TIMEOUT_MS,
		);
	});
});

/** A reloader whose every edge is observable and nothing binds a port. */
function reloaderHarness(overrides: Partial<HostsReloaderDeps> = {}) {
	const state = {
		routes: [] as Array<{ hostname: string; port: number }>,
		fingerprint: "cert-v1",
		gap: undefined as string | undefined,
		binds: 0,
		stops: 0,
		logs: [] as string[],
		syncedHostnames: [] as string[][],
		cleaned: 0,
		idleExits: 0,
		clock: 0,
	};

	const deps: HostsReloaderDeps = {
		pruneRoutes: async () => state.routes,
		certificateFingerprint: () => state.fingerprint,
		describeCertificateGap: () => state.gap,
		readCertificatePair: async () => ({ cert: "CERT", key: "KEY" }),
		startProxy: async () => {
			state.binds += 1;
			return {
				httpsPort: 443,
				stop: () => {
					state.stops += 1;
				},
			} satisfies LocalProxy;
		},
		syncHostsFile: (hostnames) => {
			state.syncedHostnames.push(hostnames);
		},
		cleanHostsFile: () => {
			state.cleaned += 1;
		},
		log: (message) => state.logs.push(message),
		now: () => state.clock,
		onIdleExit: () => {
			state.idleExits += 1;
		},
		service: false,
		...overrides,
	};

	return { state, reloader: createHostsReloader(deps) };
}

const route = (hostname: string, port: number) => ({ hostname, port });

describe("createHostsReloader", () => {
	it("binds once and leaves the listener alone while nothing changes", async () => {
		const { state, reloader } = reloaderHarness();
		state.routes = [route("web.demo.localhost", 5173)];

		await reloader.reload();
		await reloader.reload();
		await reloader.reload();

		expect(state.binds).toBe(1);
		expect(state.stops).toBe(0);
		expect(reloader.isBound()).toBe(true);
	});

	it("does not rebind when only the route set changes", async () => {
		const { state, reloader } = reloaderHarness();
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();

		// An app registering or expiring must not drop proxied websockets.
		state.routes = [
			route("web.demo.localhost", 5173),
			route("api.demo.localhost", 3000),
		];
		await reloader.reload();
		state.routes = [route("api.demo.localhost", 3000)];
		await reloader.reload();

		expect(state.binds).toBe(1);
		expect(state.stops).toBe(0);
		expect(state.syncedHostnames.at(-1)).toEqual(["api.demo.localhost"]);
	});

	it("rebinds when the CLI remints the certificate underneath it", async () => {
		const { state, reloader } = reloaderHarness();
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();

		state.fingerprint = "cert-v2";
		await reloader.reload();

		expect(state.binds).toBe(2);
		expect(state.stops).toBe(1);
	});

	it("serves what the certificate covers and only logs the gap", async () => {
		const { state, reloader } = reloaderHarness();
		state.routes = [
			route("web.demo.localhost", 5173),
			route("api.demo.localhost", 3000),
		];
		state.gap = "Named-hosts certificate does not cover web.demo.localhost.";

		// Refusing the whole reload here used to back the daemon off for up to
		// 30s, delaying every other project's routes over one uncovered worktree.
		await reloader.reload();
		expect(state.binds).toBe(1);
		expect(reloader.isBound()).toBe(true);
		expect(state.logs.join("\n")).toContain("does not cover");

		// Reported once, not on every route change while it persists.
		state.logs.length = 0;
		state.routes = [...state.routes, route("admin.demo.localhost", 4000)];
		await reloader.reload();
		expect(state.logs).toEqual([]);

		// Clearing a gap means the CLI reminted, which the fingerprint reflects.
		state.gap = undefined;
		state.fingerprint = "cert-v2";
		await reloader.reload();
		expect(state.logs.join("\n")).toContain("covers every registered hostname");
	});

	it("keeps serving the previous routes when the registry cannot be read", async () => {
		let unreadable = false;
		const { state, reloader } = reloaderHarness({
			pruneRoutes: async () => {
				if (unreadable) throw new Error("EACCES");
				return state.routes;
			},
		});
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();

		// An unreadable registry is not an empty one: clearing here would 404
		// every named URL on the machine until the file came back.
		unreadable = true;
		await expect(reloader.reload()).rejects.toThrow("EACCES");
		expect(reloader.routes().hostnames).toEqual(["web.demo.localhost"]);
		expect(state.stops).toBe(0);
	});

	it("advances the reload timestamp only on a successful load", async () => {
		const { state, reloader } = reloaderHarness();
		state.clock = 1_000;
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();
		expect(reloader.routes().lastReloadAt).toBe(1_000);

		state.clock = 2_000;
		await reloader.reload();
		expect(reloader.routes().lastReloadAt).toBe(2_000);
	});

	it("retries the rebind after startProxy fails", async () => {
		let attempts = 0;
		const { state, reloader } = reloaderHarness({
			startProxy: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("EADDRINUSE");
				return { httpsPort: 443, stop: () => {} } satisfies LocalProxy;
			},
		});
		state.routes = [route("web.demo.localhost", 5173)];

		await expect(reloader.reload()).rejects.toThrow("EADDRINUSE");
		expect(reloader.isBound()).toBe(false);

		await reloader.reload();
		expect(attempts).toBe(2);
		expect(reloader.isBound()).toBe(true);
	});

	it("reports an unwritable /etc/hosts once per cause instead of silently", async () => {
		const { state, reloader } = reloaderHarness({
			syncHostsFile: () => {
				throw new Error("EACCES: permission denied");
			},
		});
		state.routes = [route("web.demo.localhost", 5173)];

		await reloader.reload();
		await reloader.reload();
		await reloader.reload();

		const complaints = state.logs.filter((line) => line.includes("/etc/hosts"));
		expect(complaints).toHaveLength(1);
		expect(complaints[0]).toContain("EACCES");
	});

	it("exits a user-level daemon once it has been idle long enough", async () => {
		const { state, reloader } = reloaderHarness();
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();

		state.routes = [];
		await reloader.reload();
		expect(state.idleExits).toBe(0);

		state.clock += 30_001;
		await reloader.reload();
		expect(state.idleExits).toBe(1);
		expect(state.cleaned).toBe(1);
	});

	it("never idle-exits the system service", async () => {
		const { state, reloader } = reloaderHarness({ service: true });
		state.routes = [];

		await reloader.reload();
		state.clock += 600_000;
		await reloader.reload();

		expect(state.idleExits).toBe(0);
		expect(state.cleaned).toBe(0);
	});

	it("leaves /etc/hosts alone when syncing is turned off", async () => {
		const { state, reloader } = reloaderHarness({
			syncHostsFile: undefined,
			cleanHostsFile: undefined,
		});
		state.routes = [route("web.demo.localhost", 5173)];

		await reloader.reload();

		expect(state.syncedHostnames).toEqual([]);
		expect(state.binds).toBe(1);
	});
});

describe("waitForDaemonRoutes", () => {
	const servers: LocalProxy[] = [];
	const dirs: string[] = [];
	const originalHome = process.env.HOME;

	afterEach(() => {
		for (const server of servers.splice(0)) server.stop();
		process.env.HOME = originalHome;
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	/** A plain-HTTP proxy the config points at, so no certificate is needed. */
	async function daemonServing(hostnames: string[]): Promise<number> {
		const home = mkdtempSync(join(tmpdir(), "buncargo-daemon-test-"));
		dirs.push(home);
		process.env.HOME = home;

		const proxy = await startLocalProxy({
			lookup: () => undefined,
			routes: () => ({ hostnames, lastReloadAt: Date.now() }),
			httpsPort: 0,
			hostname: "127.0.0.1",
		});
		servers.push(proxy);
		writeDaemonConfig({
			httpsPort: proxy.httpsPort,
			httpPort: 0,
			tls: false,
		});
		return proxy.httpsPort;
	}

	it("passes once the daemon reports the hostnames", async () => {
		await daemonServing(["web.demo.localhost"]);
		expect(await waitForDaemonRoutes(["web.demo.localhost"])).toEqual({
			ok: true,
		});
	});

	// The failure this exists to prevent: the registry has the route, the
	// daemon does not, and the banner advertises an https URL that 404s.
	it("fails a hostname the daemon never picks up", async () => {
		await daemonServing(["other.demo.localhost"]);
		const result = await waitForDaemonRoutes(["web.demo.localhost"], {
			timeoutMs: 150,
		});
		expect(result).toEqual({
			ok: false,
			reason: "the daemon is not serving web.demo.localhost",
		});
	});

	it("reports a daemon that is not answering at all", async () => {
		await daemonServing([]);
		for (const server of servers.splice(0)) server.stop();
		const result = await waitForDaemonRoutes(["web.demo.localhost"], {
			timeoutMs: 0,
		});
		expect(result.ok).toBe(false);
	});

	// A daemon predating the field cannot be checked, and reporting that as a
	// failure would downgrade every URL on a machine whose service is merely
	// due an upgrade — which `describeStaleHostsService` already reports.
	it("proceeds against a daemon that does not report hostnames", async () => {
		const home = mkdtempSync(join(tmpdir(), "buncargo-daemon-test-"));
		dirs.push(home);
		process.env.HOME = home;

		const legacy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ ok: true, routes: 0 }),
		});
		const port = legacy.port ?? 0;
		servers.push({ httpsPort: port, stop: () => legacy.stop(true) });
		writeDaemonConfig({ httpsPort: port, httpPort: 0, tls: false });

		expect(await waitForDaemonRoutes(["web.demo.localhost"])).toEqual({
			ok: true,
			unverifiable: true,
		});
	});
});

describe("waitForDaemonHealthy", () => {
	it("fails a closed port without waiting the launchd budget", async () => {
		const started = Date.now();
		expect(await waitForDaemonHealthy(59_999, 0)).toBe(false);
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("returns as soon as the wait budget elapses", async () => {
		const started = Date.now();
		expect(await waitForDaemonHealthy(59_999, 400)).toBe(false);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(200);
		expect(elapsed).toBeLessThan(1_500);
	});
});
