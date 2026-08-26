import { describe, expect, it } from "bun:test";
import {
	createHostsReloader,
	DAEMON_START_TIMEOUT_MS,
	type HostsReloaderDeps,
	nextReloadDelayMs,
	resolveInstalledServiceWaitMs,
	SERVICE_START_TIMEOUT_MS,
	waitForDaemonHealthy,
} from "./daemon";
import type { LocalProxy } from "./proxy";

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

	it("throws the certificate gap and keeps the listener unbound", async () => {
		const { state, reloader } = reloaderHarness();
		state.routes = [route("web.demo.localhost", 5173)];
		state.gap = "Named-hosts certificate does not cover web.demo.localhost.";

		await expect(reloader.reload()).rejects.toThrow("does not cover");
		expect(state.binds).toBe(0);
		expect(reloader.isBound()).toBe(false);

		// Self-heals once the CLI has minted, with no restart.
		state.gap = undefined;
		await reloader.reload();
		expect(state.binds).toBe(1);
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
