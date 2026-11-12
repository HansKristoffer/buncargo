import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CERTIFICATE_RECHECK_MS,
	createHostsReloader,
	createStallHandler,
	type HostsReloaderDeps,
	nextReloadDelayMs,
	RELOAD_STALL_MS,
	STALLED_EXIT_MS,
	truncateOversizedLog,
} from "./daemon";
import {
	DAEMON_RESTART_GRACE_MS,
	describeLoopbackHijack,
	ensureHostsDaemonRunning,
	type HostsDaemonProbe,
	SERVICE_START_TIMEOUT_MS,
	waitForDaemonRoutes,
} from "./daemon-client";
import {
	createProxyFetch,
	HEALTH_PATH,
	type LocalProxy,
	type ProxyRouteLookup,
	startLocalProxy,
} from "./proxy";
import { TEST_TLS } from "./test-tls.testing";

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

	// Short: a browser on a route nobody refreshed for waits on this loop, so
	// a long ceiling meant one project's failure delayed every other
	// project's routes for that long.
	it("caps the backoff so recovery is still noticed", () => {
		expect(nextReloadDelayMs(50)).toBe(5_000);
	});
});

describe("createStallHandler", () => {
	function stalledDaemon() {
		const events: string[] = [];
		const onStale = createStallHandler({
			reload: () => events.push("reload"),
			log: () => {},
			exit: (code) => events.push(`exit ${code}`),
		});
		return { events, onStale };
	}

	// An exit drops every proxied websocket on the machine, so the first
	// answer to a stall is a reload from the request that noticed it.
	it("reloads in-band while the stall is younger than the exit window", () => {
		const { events, onStale } = stalledDaemon();
		onStale(RELOAD_STALL_MS + 1);
		onStale(STALLED_EXIT_MS);
		expect(events).toEqual(["reload", "reload"]);
	});

	// A reload that hangs is joined, not stacked on: only an exit gets the
	// supervisor to start a daemon that is not stuck behind it.
	it("exits for the supervisor once in-band reloads have not refreshed the map", () => {
		const { events, onStale } = stalledDaemon();
		onStale(STALLED_EXIT_MS + 1);
		expect(events).toEqual(["exit 1"]);
	});
});

describe("start timeouts", () => {
	// launchd cold-starting a unit is the only thing worth waiting seconds for.
	it("allows enough time for the supervisor to load the unit", () => {
		expect(SERVICE_START_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
	});
});

/** A reloader whose every edge is observable and nothing binds a port. */
function reloaderHarness(overrides: Partial<HostsReloaderDeps> = {}) {
	const state = {
		routes: [] as Array<{ hostname: string; port: number; root: string }>,
		requests: [] as string[],
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
		certificateServes: () => () => true,
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
		onRequest: (root) => state.requests.push(root),
		service: false,
		...overrides,
	};

	return { state, reloader: createHostsReloader(deps) };
}

const route = (hostname: string, port: number) => ({
	hostname,
	port,
	root: `/checkouts/${hostname}`,
});

describe("createHostsReloader", () => {
	it("coalesces overlapping recovery and normal reloads into one replacement", async () => {
		let active = 0;
		let maximum = 0;
		let binds = 0;
		const events: Array<{ reason: string; count: number }> = [];
		const { reloader } = reloaderHarness({
			onReload: (event) => events.push(event),
			startProxy: async () => {
				active += 1;
				maximum = Math.max(maximum, active);
				binds += 1;
				await Bun.sleep(30);
				active -= 1;
				return { httpsPort: 443, stop: () => {} };
			},
		});
		await Promise.all([
			reloader.reload("poll"),
			reloader.reload("recovery"),
			reloader.reload("manual"),
		]);
		expect(binds).toBe(1);
		expect(maximum).toBe(1);
		expect(events).toEqual([{ reason: "poll", count: 1 }]);
	});

	it("stops a replacement that finishes binding after shutdown", async () => {
		let begin!: () => void;
		const started = new Promise<void>((resolve) => {
			begin = resolve;
		});
		let finish!: () => void;
		const release = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let stops = 0;
		const { reloader } = reloaderHarness({
			startProxy: async () => {
				begin();
				await release;
				return {
					httpsPort: 443,
					stop: () => {
						stops += 1;
					},
				};
			},
		});
		const loading = reloader.reload();
		await started;
		reloader.stop();
		finish();
		await loading;
		expect(stops).toBe(1);
		expect(reloader.isBound()).toBe(false);
	});

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

	// The window this closes: with the old listener stopped first, nothing
	// answered :443 until the new one bound, and a CLI health probe landing
	// there downgraded that run to localhost:port. The remint for a new
	// worktree's hostnames is exactly what triggers a rebind.
	it("binds the replacement before stopping the old listener", async () => {
		const order: string[] = [];
		const { state, reloader } = reloaderHarness({
			startProxy: async () => {
				order.push("bind");
				return {
					httpsPort: 443,
					stop: () => order.push("stop"),
				} satisfies LocalProxy;
			},
		});
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();

		state.fingerprint = "cert-v2";
		await reloader.reload();

		expect(order).toEqual(["bind", "bind", "stop"]);
	});

	// A failed rebind must not take the working listener down with it: the old
	// certificate still serves every hostname it covered a moment ago.
	it("keeps the previous listener serving when the rebind fails", async () => {
		let attempts = 0;
		const { state, reloader } = reloaderHarness({
			startProxy: async () => {
				attempts += 1;
				if (attempts === 2) throw new Error("EADDRINUSE");
				state.binds += 1;
				return {
					httpsPort: 443,
					stop: () => {
						state.stops += 1;
					},
				} satisfies LocalProxy;
			},
		});
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();

		state.fingerprint = "cert-v2";
		await expect(reloader.reload()).rejects.toThrow("EADDRINUSE");
		expect(reloader.isBound()).toBe(true);
		expect(state.stops).toBe(0);

		// And the retry still rebinds: the failure left the fingerprint unadvanced.
		await reloader.reload();
		expect(state.binds).toBe(2);
		expect(state.stops).toBe(1);
	});

	// The proxy reads this view on every request, for its age. Building the
	// list there cost each proxied request a certificate check per route.
	it("builds the served hostname list for health, not for a proxied request", async () => {
		let certificateChecks = 0;
		let lookup: ProxyRouteLookup = () => undefined;
		const { state, reloader } = reloaderHarness({
			certificateServes: () => () => {
				certificateChecks += 1;
				return true;
			},
			startProxy: async (input) => {
				lookup = input.lookup;
				return { httpsPort: 443, stop: () => {} } satisfies LocalProxy;
			},
		});
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();
		const fetchHandler = createProxyFetch({
			lookup,
			routes: reloader.routes,
			upstream: { resolve: async () => undefined, forget: () => {} },
		});

		certificateChecks = 0;
		const proxied = await fetchHandler(
			new Request("https://web.demo.localhost/", {
				headers: { host: "web.demo.localhost" },
			}),
			{} as never,
		);
		expect(proxied.status).toBe(502);
		expect(certificateChecks).toBe(0);

		const health = await fetchHandler(
			new Request(`https://127.0.0.1${HEALTH_PATH}`),
			{} as never,
		);
		expect(await health.json()).toMatchObject({
			hostnames: ["web.demo.localhost"],
		});
		expect(certificateChecks).toBe(1);
	});

	// The failure this pins: health listed the new hostnames while the old
	// listener kept the old leaf, so `waitForDaemonRoutes` passed and the run
	// advertised https URLs that failed TLS.
	it("reports only what the bound certificate serves while a rebind fails", async () => {
		const covers: Record<string, string[]> = {
			"cert-v1": ["web.demo.localhost"],
			"cert-v2": ["web.demo.localhost", "api.demo.localhost"],
		};
		let failBind = false;
		const { state, reloader } = reloaderHarness({
			readCertificatePair: async () => ({ cert: state.fingerprint, key: "K" }),
			certificateServes: (cert) => (hostname) =>
				covers[cert]?.includes(hostname) ?? false,
			startProxy: async () => {
				if (failBind) throw new Error("EADDRINUSE");
				return { httpsPort: 443, stop: () => {} } satisfies LocalProxy;
			},
		});
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();
		expect(reloader.routes().hostnames).toEqual(["web.demo.localhost"]);

		state.routes = [...state.routes, route("api.demo.localhost", 3000)];
		state.fingerprint = "cert-v2";
		failBind = true;
		await expect(reloader.reload()).rejects.toThrow("EADDRINUSE");
		expect(reloader.routes().hostnames).toEqual(["web.demo.localhost"]);
		expect(reloader.routes().bindError).toBe("EADDRINUSE");

		failBind = false;
		await reloader.reload();
		expect(reloader.routes().hostnames.sort()).toEqual([
			"api.demo.localhost",
			"web.demo.localhost",
		]);
		expect(reloader.routes().bindError).toBeUndefined();
	});

	// A pass that finds a mint holding the pair binds nothing, and used to
	// clear the failure all the same, so health dropped a bind failure that
	// still stood every time a mint was in progress.
	it("keeps reporting a failed bind while a mint holds the pair", async () => {
		let failBind = false;
		let minting = false;
		const { state, reloader } = reloaderHarness({
			readCertificatePair: async () =>
				minting ? undefined : { cert: state.fingerprint, key: "K" },
			startProxy: async () => {
				if (failBind) throw new Error("EADDRINUSE");
				return { httpsPort: 443, stop: () => {} } satisfies LocalProxy;
			},
		});
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();

		state.fingerprint = "cert-v2";
		failBind = true;
		await expect(reloader.reload()).rejects.toThrow("EADDRINUSE");

		minting = true;
		state.fingerprint = "cert-v3";
		await reloader.reload();
		expect(reloader.routes().bindError).toBe("EADDRINUSE");

		minting = false;
		failBind = false;
		await reloader.reload();
		expect(reloader.routes().bindError).toBeUndefined();
	});

	// Bun.serve bound it, so it serves something; listing nothing put every
	// run on the machine on localhost:port without a word.
	it("lists the route map, and says so once, when the bound leaf cannot be read", async () => {
		const { state, reloader } = reloaderHarness({
			certificateServes: () => undefined,
		});
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();
		expect(reloader.routes().hostnames).toEqual(["web.demo.localhost"]);

		state.routes = [...state.routes, route("api.demo.localhost", 3000)];
		await reloader.reload();
		expect(reloader.routes().hostnames.sort()).toEqual([
			"api.demo.localhost",
			"web.demo.localhost",
		]);
		const said = state.logs.filter((line) => line.includes("could not read"));
		expect(said).toHaveLength(1);
	});

	it("serves nothing once the bound certificate has expired", async () => {
		const expiresAt = 10_000;
		const { state, reloader } = reloaderHarness({
			certificateServes: () => (_hostname, now) => now < expiresAt,
		});
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();
		expect(reloader.routes().hostnames).toEqual(["web.demo.localhost"]);

		state.clock = expiresAt;
		expect(reloader.routes().hostnames).toEqual([]);
	});

	// Expiry arrives with no route change or remint, which is all that used
	// to trigger a check, so a daemon up for months never reported it.
	it("checks the certificate again while nothing changes", async () => {
		const { state, reloader } = reloaderHarness();
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();

		state.gap = "Named-hosts certificate expires on 2026-12-01.";
		await reloader.reload();
		expect(state.logs.join("\n")).not.toContain("expires on");

		state.clock += CERTIFICATE_RECHECK_MS;
		await reloader.reload();
		expect(state.logs.join("\n")).toContain("expires on 2026-12-01");
		expect(state.binds).toBe(1);
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

	it("counts a proxied request against its route's checkout, and nothing for an unknown host", async () => {
		// What a detached run's idle limit reads: a request through the proxy
		// is the run being used.
		let lookup: ((hostname: string) => number | undefined) | undefined;
		const { state, reloader } = reloaderHarness({
			startProxy: async (input) => {
				lookup = input.lookup;
				return { httpsPort: 443, stop: () => {} } satisfies LocalProxy;
			},
		});
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();

		expect(lookup?.("web.demo.localhost")).toBe(5173);
		expect(lookup?.("nope.demo.localhost")).toBeUndefined();
		expect(state.requests).toEqual(["/checkouts/web.demo.localhost"]);
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

	// `routes.json` is user-writable and the daemon is root: a newline in a
	// hostname was lines of anyone's choosing in /etc/hosts.
	it("keeps a hostname that is not a DNS name out of the map and /etc/hosts, and says so once", async () => {
		const injected = "evil.localhost\n203.0.113.7 bank.example";
		const { state, reloader } = reloaderHarness();
		state.routes = [route("web.demo.localhost", 5173), route(injected, 4000)];

		await reloader.reload();
		await reloader.reload();

		expect(state.syncedHostnames.at(-1)).toEqual(["web.demo.localhost"]);
		expect(reloader.routes().hostnames).toEqual(["web.demo.localhost"]);
		const said = state.logs.filter((line) => line.includes("not a DNS name"));
		expect(said).toEqual([expect.stringContaining(JSON.stringify(injected))]);
	});

	// Advanced on success alone, a registry the daemon could not read looked
	// like a loop that had stopped, and stall recovery exited the daemon.
	it("advances the reload timestamp on every reload that finishes", async () => {
		let unreadable = false;
		const { state, reloader } = reloaderHarness({
			pruneRoutes: async () => {
				if (unreadable) throw new Error("routes.json is not valid JSON");
				return state.routes;
			},
		});
		state.clock = 1_000;
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();
		expect(reloader.routes().lastReloadAt).toBe(1_000);

		unreadable = true;
		state.clock = 2_000;
		await expect(reloader.reload()).rejects.toThrow("not valid JSON");
		expect(reloader.routes().lastReloadAt).toBe(2_000);
	});

	// The reload already running may have read the registry before the CLI's
	// write landed: a refresh that joined it answered without the new route.
	it("refreshes with a reload that starts after it is asked", async () => {
		const passes = Promise.withResolvers<void>();
		const reads: string[][] = [];
		const { state, reloader } = reloaderHarness({
			pruneRoutes: async () => {
				reads.push(state.routes.map((entry) => entry.hostname));
				if (reads.length === 1) await passes.promise;
				return state.routes;
			},
		});
		const polling = reloader.reload("poll");
		state.routes = [route("web.demo.localhost", 5173)];
		const refreshing = reloader.refresh();
		passes.resolve();
		await Promise.all([polling, refreshing]);

		expect(reads).toEqual([[], ["web.demo.localhost"]]);
		expect(reloader.routes().hostnames).toEqual(["web.demo.localhost"]);
	});

	it("gives refreshes that arrive together one reload", async () => {
		const passes = Promise.withResolvers<void>();
		let reads = 0;
		const { state, reloader } = reloaderHarness({
			pruneRoutes: async () => {
				reads += 1;
				if (reads === 1) await passes.promise;
				return state.routes;
			},
		});
		const polling = reloader.reload("poll");
		const refreshes = [reloader.refresh(), reloader.refresh()];
		passes.resolve();
		await Promise.all([polling, ...refreshes]);

		expect(reads).toBe(2);
	});

	// Every remint binds again and meets the same holder of :80.
	it("says once that https is serving without the http redirect", async () => {
		const { state, reloader } = reloaderHarness({
			startProxy: async () =>
				({
					httpsPort: 443,
					redirectError: "could not bind :80 (EADDRINUSE)",
					stop: () => {},
				}) satisfies LocalProxy,
		});
		state.routes = [route("web.demo.localhost", 5173)];
		await reloader.reload();
		state.fingerprint = "cert-v2";
		await reloader.reload();

		expect(reloader.isBound()).toBe(true);
		const said = state.logs.filter((line) => line.includes(":80"));
		expect(said).toEqual([
			"[buncargo hosts] serving https without the http:// redirect: could not bind :80 (EADDRINUSE)",
		]);
	});

	// mkcert runs under the certificate lock. A slow mint used to read as a
	// failed reload and back the daemon off.
	it("waits out a mint in progress without failing the reload", async () => {
		let minting = true;
		const { state, reloader } = reloaderHarness({
			readCertificatePair: async () =>
				minting ? undefined : { cert: "CERT", key: "KEY" },
		});
		state.routes = [route("web.demo.localhost", 5173)];

		await reloader.reload();
		expect(reloader.isBound()).toBe(false);
		expect(reloader.routes().bindError).toBeUndefined();

		minting = false;
		await reloader.reload();
		expect(reloader.isBound()).toBe(true);
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

	afterEach(() => {
		for (const server of servers.splice(0)) server.stop();
	});

	/** A proxy bound the way the daemon binds it, on a port of its own. */
	async function daemonServing(
		hostnames: string[],
		options: { bindError?: string } = {},
	): Promise<number> {
		const proxy = await startLocalProxy({
			lookup: () => undefined,
			routes: () => ({ hostnames, lastReloadAt: Date.now(), ...options }),
			tls: TEST_TLS,
			httpsPort: 0,
			hostname: "127.0.0.1",
		});
		servers.push(proxy);
		return proxy.httpsPort;
	}

	it("passes once the daemon reports the hostnames", async () => {
		const port = await daemonServing(["web.demo.localhost"]);
		expect(await waitForDaemonRoutes(["web.demo.localhost"], { port })).toEqual(
			{ ok: true },
		);
	});

	// The route lands in the registry just before the check: the daemon's own
	// loop has not read it yet, and the one probe the budget allows has the
	// daemon reload before it answers.
	it("settles in one round trip by asking the daemon to reload first", async () => {
		let hostnames: string[] = [];
		const proxy = await startLocalProxy({
			lookup: () => undefined,
			routes: () => ({ hostnames, lastReloadAt: Date.now() }),
			refresh: async () => {
				hostnames = ["web.demo.localhost"];
			},
			tls: TEST_TLS,
			httpsPort: 0,
			hostname: "127.0.0.1",
		});
		servers.push(proxy);

		expect(
			await waitForDaemonRoutes(["web.demo.localhost"], {
				port: proxy.httpsPort,
				timeoutMs: 0,
			}),
		).toEqual({ ok: true });
	});

	// The failure this exists to prevent: the registry has the route, the
	// daemon does not, and the banner advertises an https URL that 404s. Still
	// told apart from a daemon that never answered: a registry it is not
	// picking up is a different repair.
	it("names a hostname the daemon never picks up", async () => {
		const port = await daemonServing(["other.demo.localhost"]);
		const result = await waitForDaemonRoutes(["web.demo.localhost"], {
			timeoutMs: 150,
			port,
		});
		expect(result).toEqual({
			ok: false,
			reason: expect.stringContaining(
				"the daemon is not serving web.demo.localhost",
			),
		});
	});

	it("reports a daemon that is not answering at all", async () => {
		const port = await daemonServing([]);
		for (const server of servers.splice(0)) server.stop();
		const result = await waitForDaemonRoutes(["web.demo.localhost"], {
			timeoutMs: 0,
			port,
		});
		expect(result).toEqual({
			ok: false,
			reason: expect.stringContaining("stopped answering"),
		});
	});

	// A refresh that remints rebinds the listener, and the rebind cuts off the
	// very probe that asked for it: the normal shape of a first run in a new
	// worktree. Failing on it downgraded that run to localhost:port while
	// everything was fine.
	it("retries a probe the rebind cut off instead of giving up", async () => {
		let replacement: Promise<LocalProxy> | undefined;
		const previous = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: TEST_TLS,
			reusePort: true,
			fetch: async (_request, server) => {
				replacement ??= startLocalProxy({
					lookup: () => undefined,
					routes: () => ({
						hostnames: ["web.demo.localhost"],
						lastReloadAt: Date.now(),
					}),
					tls: TEST_TLS,
					httpsPort: server.port ?? 0,
					hostname: "127.0.0.1",
				});
				servers.push(await replacement);
				server.stop(true);
				return new Response("cut off");
			},
		});

		expect(
			await waitForDaemonRoutes(["web.demo.localhost"], {
				timeoutMs: 3000,
				port: previous.port,
			}),
		).toEqual({ ok: true });
		expect(replacement).toBeDefined();
	});

	it("names a certificate the daemon cannot load as the reason", async () => {
		const port = await daemonServing(["other.demo.localhost"], {
			bindError: "key values mismatch",
		});
		const result = await waitForDaemonRoutes(["web.demo.localhost"], {
			timeoutMs: 0,
			port,
		});
		expect(result).toEqual({
			ok: false,
			reason: expect.stringContaining(
				"could not load the certificate covering web.demo.localhost (key values mismatch)",
			),
		});
	});

	// The friend-of-a-user failure: every CLI check passes over 127.0.0.1
	// while the browser dials [::1]:443 and gets someone else's plain HTTP.
	it("fails when another server answers on the other loopback family", async () => {
		const port = await daemonServing(["web.demo.localhost"]);
		let squatter: ReturnType<typeof Bun.serve> | undefined;
		try {
			squatter = Bun.serve({
				hostname: "::1",
				port,
				reusePort: true,
				fetch: () => new Response("not buncargo"),
			});
		} catch {
			return; // no IPv6 loopback here
		}
		servers.push({ httpsPort: port, stop: () => squatter?.stop(true) });
		expect(await describeLoopbackHijack(port)).toContain(`[::1]:${port}`);
		expect(await waitForDaemonRoutes(["web.demo.localhost"], { port })).toEqual(
			{
				ok: false,
				reason: expect.stringContaining(`[::1]:${port}`),
			},
		);
	});

	// What every machine runs until `hosts install` replaces it. It cannot
	// prove what it serves the way this CLI asks, so it is not served on
	// trust: the run falls back and says how to update it.
	it("tells the user to update a daemon from before the protocol", async () => {
		const outdated = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: TEST_TLS,
			fetch: () =>
				Response.json({
					ok: true,
					routes: 1,
					hostnames: ["web.demo.localhost"],
					lastReloadAt: Date.now(),
				}),
		});
		const port = outdated.port ?? 0;
		servers.push({ httpsPort: port, stop: () => outdated.stop(true) });

		expect(await waitForDaemonRoutes(["web.demo.localhost"], { port })).toEqual(
			{
				ok: false,
				reason: expect.stringContaining(
					"Run `buncargo hosts install` to update it.",
				),
			},
		);
	});
});

describe("ensureHostsDaemonRunning", () => {
	/** An installed, current unit whose daemon first answers at `answersAt`. */
	function restartingDaemon(answersAt: number) {
		const clock = { now: 0 };
		const probe: HostsDaemonProbe = {
			healthy: async () => clock.now >= answersAt,
			serviceInstalled: () => true,
			staleService: () => undefined,
			squatter: () => undefined,
			now: () => clock.now,
			sleep: async (ms) => {
				clock.now += ms;
			},
		};
		return { clock, probe };
	}

	// Down after its own stall exit, another project's reinstall, or login:
	// one unanswered probe kept the run on localhost:port for its whole life.
	it("attaches to a daemon that answers a second after the first probe", async () => {
		const { probe } = restartingDaemon(1_000);
		expect(await ensureHostsDaemonRunning(probe)).toEqual({ ok: true });
	});

	it("reports the service once the restart grace has passed", async () => {
		const { clock, probe } = restartingDaemon(Number.POSITIVE_INFINITY);
		const result = await ensureHostsDaemonRunning(probe);
		expect(result).toMatchObject({
			ok: false,
			message: expect.stringContaining("did not answer"),
		});
		expect(clock.now).toBe(DAEMON_RESTART_GRACE_MS);
	});
});

/**
 * The service log is append-only and the daemon runs for weeks. A version that
 * crash-looped left 800KB of one repeated line on a real machine — useless, and
 * the first file anyone opens when named hosts break.
 */
describe("truncateOversizedLog", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function logFile(contents: string): string {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-log-"));
		dirs.push(dir);
		const path = join(dir, "buncargo-hosts.log");
		writeFileSync(path, contents);
		return path;
	}

	it("leaves a log that is still a reasonable size", () => {
		const path = logFile("one line\n");
		truncateOversizedLog(path, 1000);
		expect(readFileSync(path, "utf-8")).toBe("one line\n");
	});

	it("truncates an oversized log and says so", () => {
		const path = logFile("x".repeat(5000));
		truncateOversizedLog(path, 1000);
		const contents = readFileSync(path, "utf-8");
		expect(statSync(path).size).toBeLessThan(1000);
		expect(contents).toContain("earlier log truncated");
	});

	it("does nothing when there is no log to manage", () => {
		expect(() =>
			truncateOversizedLog("/nonexistent/buncargo-hosts.log", 1),
		).not.toThrow();
	});
});
