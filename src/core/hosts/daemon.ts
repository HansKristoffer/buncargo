import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { readJsonDocumentSync, writeJsonDocumentSync } from "../registry-file";
import {
	DEFAULT_HOSTS_DAEMON_PORT,
	hostsDaemonPort,
	shouldSyncHostsFile,
} from "../runtime-flags";
import { sleep } from "../utils";
import {
	certificateFingerprint,
	describeCertificateGap,
	readCertificatePair,
} from "./certificates";
import { cleanHostsFile, syncHostsFile } from "./hosts-file";
import {
	chownToInvokingUser,
	getDaemonConfigPath,
	getHostsStateDir,
	getPidfilePath,
} from "./paths";
import {
	isProxyHealthy,
	type LocalProxy,
	type ProxyHealth,
	type ProxyRouteLookup,
	type ProxyRoutesView,
	readProxyHealth,
	startLocalProxy,
} from "./proxy";
import { pruneHostRoutes } from "./registry";
import { describeStaleHostsService, isHostsServiceInstalled } from "./service";
import { hostsServiceLogHint } from "./service-files";
import { describePortSquatter } from "./squatter";

const DEFAULT_HTTP_PORT = 80;
const IDLE_EXIT_MS = 30_000;
const RELOAD_INTERVAL_MS = 1000;
const MAX_RELOAD_BACKOFF_MS = 30_000;

/**
 * How long without a successful refresh before the route map is presumed frozen.
 *
 * Comfortably above {@link MAX_RELOAD_BACKOFF_MS} so a daemon that is merely
 * backing off through a run of failures is not mistaken for a dead one.
 */
export const RELOAD_STALL_MS = 45_000;

/**
 * Failed in-band recoveries before the daemon gives up and lets the supervisor
 * restart it. Two is enough to tell a transient read error from a wedge.
 */
const MAX_STALL_RECOVERIES = 2;

/**
 * Write straight to fd 2, bypassing the buffering Bun applies when stderr is a
 * file rather than a TTY.
 *
 * The service redirects stderr to `/var/log/buncargo-hosts.log` and then never
 * exits, so a buffered `console.error` would sit in memory forever and the log
 * would stay empty exactly when it is needed.
 */
function logDaemonError(message: string): void {
	try {
		writeSync(2, `${message}\n`);
	} catch {
		console.error(message);
	}
}

/**
 * Back off after a failed reload instead of retrying every second.
 *
 * launchd runs the service with `KeepAlive`, so an unhandled throw would be
 * respawned forever. The daemon stays up and retries on a widening interval.
 */
export function nextReloadDelayMs(consecutiveFailures: number): number {
	if (consecutiveFailures <= 0) return RELOAD_INTERVAL_MS;
	const backoff = RELOAD_INTERVAL_MS * 2 ** (consecutiveFailures - 1);
	return Math.min(backoff, MAX_RELOAD_BACKOFF_MS);
}

/** Minimum gap between two reload-failure lines, whatever the cause. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

export interface ThrottledFailureLog {
	/** Log this failure unless one was already logged inside the interval. */
	report: (message: string) => void;
	/** Note a success, so the next failure is reported immediately. */
	reset: () => void;
}

/**
 * Bound how fast a persistent failure can fill `/var/log/buncargo-hosts.log`.
 *
 * Suppressing repeats of an identical message is not enough on its own: a
 * certificate gap names the hostnames it is missing, so every app that registers
 * or expires produces a fresh message and every one of them gets through. A
 * stale service can hold that state for hours. Throttling by time instead caps
 * the file at one line a minute and carries the suppressed count, so an ongoing
 * failure stays visible — including whether it is still changing — without the
 * log growing without bound.
 */
export function createThrottledFailureLog(deps: {
	log: (message: string) => void;
	now: () => number;
	intervalMs?: number;
}): ThrottledFailureLog {
	const intervalMs = deps.intervalMs ?? FAILURE_LOG_INTERVAL_MS;
	let lastLoggedAt: number | undefined;
	let suppressed = 0;

	return {
		report(message: string) {
			const now = deps.now();
			if (lastLoggedAt !== undefined && now - lastLoggedAt < intervalMs) {
				suppressed += 1;
				return;
			}
			const suffix =
				suppressed > 0
					? ` (${suppressed} further ${suppressed === 1 ? "failure" : "failures"} suppressed)`
					: "";
			deps.log(`${message}${suffix}`);
			lastLoggedAt = now;
			suppressed = 0;
		},
		reset() {
			lastLoggedAt = undefined;
			suppressed = 0;
		},
	};
}

export interface HostsDaemonConfig {
	httpsPort: number;
	httpPort: number;
	tls: boolean;
}

function validateDaemonConfig(
	value: unknown,
): Partial<HostsDaemonConfig> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const config = value as Partial<HostsDaemonConfig>;
	return {
		httpsPort:
			typeof config.httpsPort === "number" ? config.httpsPort : undefined,
		httpPort: typeof config.httpPort === "number" ? config.httpPort : undefined,
		tls: typeof config.tls === "boolean" ? config.tls : undefined,
	};
}

export function readDaemonConfig(): HostsDaemonConfig {
	const stored =
		readJsonDocumentSync(getDaemonConfigPath(), validateDaemonConfig) ?? {};
	return {
		httpsPort: stored.httpsPort ?? hostsDaemonPort(),
		httpPort: stored.httpPort ?? DEFAULT_HTTP_PORT,
		tls: stored.tls ?? true,
	};
}

export function writeDaemonConfig(config: HostsDaemonConfig): void {
	writeJsonDocumentSync(getDaemonConfigPath(), config, {
		afterWrite: chownToInvokingUser,
	});
}

function writePidfile(pid: number): void {
	mkdirSync(getHostsStateDir(), { recursive: true });
	const path = getPidfilePath();
	writeFileSync(path, `${pid}\n`);
	chownToInvokingUser(path);
}

export function readDaemonPid(): number | undefined {
	const path = getPidfilePath();
	if (!existsSync(path)) return undefined;
	const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
	return Number.isFinite(pid) ? pid : undefined;
}

export async function isHostsDaemonHealthy(port?: number): Promise<boolean> {
	const config = readDaemonConfig();
	return isProxyHealthy(port ?? config.httpsPort, "127.0.0.1", {
		tls: config.tls,
	});
}

/** What the running daemon reports it is serving, if it answers at all. */
export async function readHostsDaemonHealth(
	port?: number,
): Promise<ProxyHealth | undefined> {
	const config = readDaemonConfig();
	return readProxyHealth(port ?? config.httpsPort, "127.0.0.1", {
		tls: config.tls,
	});
}

/**
 * A daemon that cannot serve, whether or not it answers.
 *
 * Health alone is not enough: the listener and the reload loop are independent,
 * so a daemon whose loop stopped keeps returning 200 while every named URL
 * 404s against a frozen map. Both cases want the same repair — reload it.
 */
export async function isHostsDaemonWedged(): Promise<boolean> {
	const health = await readHostsDaemonHealth();
	if (!health) return true;
	if (health.lastReloadAt === undefined) return false;
	return Date.now() - health.lastReloadAt > RELOAD_STALL_MS;
}

/** How long the CLI waits for the daemon's one-second poll to pick a route up. */
export const ROUTE_PICKUP_TIMEOUT_MS = 3000;
const ROUTE_POLL_MS = 100;

export type DaemonRouteCheck =
	| { ok: true }
	/** The daemon answers but does not report hostnames, so nothing can be proven. */
	| { ok: true; unverifiable: true }
	| { ok: false; reason: string };

/**
 * Wait until the daemon is actually serving `hostnames`.
 *
 * Registering a route only writes a file; the daemon picks it up on its own
 * poll, and a daemon whose poll has stopped keeps answering health checks with
 * a map that will never contain it. Without this the CLI advertises
 * `https://app.project.localhost` and the browser gets a 404 from our own
 * proxy — the failure this whole check exists to prevent.
 */
export async function waitForDaemonRoutes(
	hostnames: string[],
	options: { timeoutMs?: number; port?: number } = {},
): Promise<DaemonRouteCheck> {
	if (hostnames.length === 0) return { ok: true };
	const deadline = Date.now() + (options.timeoutMs ?? ROUTE_PICKUP_TIMEOUT_MS);
	let missing: string[] = [...hostnames];

	for (;;) {
		const health = await readHostsDaemonHealth(options.port);
		if (health === undefined) {
			return {
				ok: false,
				reason: `the daemon on :${readDaemonConfig().httpsPort} stopped answering`,
			};
		}
		// A daemon from before this field cannot be checked. Reporting that as a
		// failure would downgrade every URL on a machine whose service is simply
		// due an upgrade, which `describeStaleHostsService` already reports.
		if (health.hostnames === undefined) return { ok: true, unverifiable: true };

		const served = new Set(health.hostnames);
		missing = hostnames.filter((hostname) => !served.has(hostname));
		if (missing.length === 0) return { ok: true };

		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await sleep(Math.min(ROUTE_POLL_MS, remaining));
	}

	return {
		ok: false,
		reason: `the daemon is not serving ${missing.join(", ")}`,
	};
}

export interface HostsReloaderDeps {
	pruneRoutes: () => Promise<Array<{ hostname: string; port: number }>>;
	certificateFingerprint: () => string;
	describeCertificateGap: (hostnames: string[]) => string | undefined;
	readCertificatePair: () => Promise<{ cert: string; key: string }>;
	startProxy: (input: {
		lookup: ProxyRouteLookup;
		routes: () => ProxyRoutesView;
		cert: string;
		key: string;
	}) => Promise<LocalProxy>;
	/** Undefined when `/etc/hosts` syncing is turned off. */
	syncHostsFile?: (hostnames: string[]) => void;
	cleanHostsFile?: () => void;
	log: (message: string) => void;
	now: () => number;
	/** Only reached by a user-level daemon that has gone idle. */
	onIdleExit: () => void;
	service: boolean;
}

export interface HostsReloader {
	reload: () => Promise<void>;
	stop: () => void;
	/** Whether a listener is currently bound. */
	isBound: () => boolean;
	/** What the proxy reports: served hostnames and the last refresh time. */
	routes: () => ProxyRoutesView;
}

/**
 * The daemon's one job, with every edge injected.
 *
 * Kept separate from {@link runHostsDaemon} so the rebind rule can be tested
 * without binding a port, minting a certificate or waiting on real time.
 */
export function createHostsReloader(deps: HostsReloaderDeps): HostsReloader {
	const routeMap = new Map<string, number>();
	let proxy: LocalProxy | undefined;
	let lastHostKey = "";
	let lastCertKey = "";
	let idleSince: number | undefined;
	let lastHostsFileFailure: string | undefined;
	let lastCertificateGap: string | undefined;
	// Seeded rather than left undefined: a daemon that has not finished its
	// first reload is starting up, not frozen.
	let lastReloadAt = deps.now();

	const lookup: ProxyRouteLookup = (hostname) => routeMap.get(hostname);
	const routes = (): ProxyRoutesView => ({
		hostnames: [...routeMap.keys()],
		lastReloadAt,
	});

	/**
	 * An unwritable `/etc/hosts` stops named hostnames resolving, so it cannot
	 * stay silent. It also must not fail the reload or spam once a second, so
	 * it is reported once per distinct cause.
	 */
	function reportHostsFileFailure(action: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		if (message === lastHostsFileFailure) return;
		lastHostsFileFailure = message;
		deps.log(`[buncargo hosts] could not ${action} /etc/hosts: ${message}`);
	}

	/**
	 * Announce a certificate that no longer covers everything registered, and
	 * announce it again once it does. Only on a change: the gap survives until
	 * a CLI run remints, which can be hours.
	 */
	function reportCertificateGap(gap: string | undefined): void {
		if (gap === lastCertificateGap) return;
		lastCertificateGap = gap;
		deps.log(
			gap
				? `[buncargo hosts] ${gap}`
				: "[buncargo hosts] certificate now covers every registered hostname",
		);
	}

	async function reload(): Promise<void> {
		// Load before clearing, so a registry that could not be read leaves the
		// previous map serving. An unreadable file is not a file with no routes,
		// and clearing first would 404 every named URL on the machine.
		const loaded = await deps.pruneRoutes();
		routeMap.clear();
		for (const route of loaded) {
			routeMap.set(route.hostname, route.port);
		}
		lastReloadAt = deps.now();
		const hostnames = [...routeMap.keys()].sort();
		const hostKey = hostnames.join(",");
		if (hostnames.length === 0) {
			// Explicitly against undefined: a zero timestamp is a real reading,
			// and treating it as "not idle yet" restarts the clock every tick.
			if (idleSince === undefined) idleSince = deps.now();
			if (!deps.service && deps.now() - idleSince > IDLE_EXIT_MS) {
				proxy?.stop();
				try {
					deps.cleanHostsFile?.();
				} catch (error) {
					reportHostsFileFailure("clean", error);
				}
				deps.onIdleExit();
				return;
			}
		} else {
			idleSince = undefined;
		}

		try {
			deps.syncHostsFile?.(hostnames);
			lastHostsFileFailure = undefined;
		} catch (error) {
			reportHostsFileFailure("update", error);
		}

		// Only the TLS material is baked into the listener; `lookup` reads the
		// live route map. Rebinding on a route change too would drop every
		// proxied websocket each time an app registers or expires, and a dev
		// server whose HMR socket is reset mid-session usually dies with it.
		const certKey = deps.certificateFingerprint();
		const mustBind = !proxy || certKey !== lastCertKey;
		if (!mustBind && hostKey === lastHostKey) {
			return;
		}

		// Minting belongs to the CLI, which runs as the user and can find
		// mkcert. A hostname the leaf does not cover fails TLS for that
		// hostname alone, so report it and serve the rest: failing the whole
		// reload put the daemon into a widening backoff, which delayed picking
		// up every *other* project's routes because one worktree was uncovered.
		reportCertificateGap(deps.describeCertificateGap(hostnames));

		lastHostKey = hostKey;
		if (!mustBind) return;

		// Read before stopping: an unreadable pair should leave the running
		// listener alone rather than take every named URL down first.
		const { cert, key } = await deps.readCertificatePair();

		// Clear before rebinding: if startProxy throws, the retry must not find
		// a stopped server sitting in `proxy` and skip the rebind.
		const stopped = proxy;
		proxy = undefined;
		stopped?.stop();
		proxy = await deps.startProxy({
			lookup,
			routes,
			cert,
			key,
		});
		lastCertKey = certKey;
	}

	return {
		reload,
		stop: () => proxy?.stop(),
		isBound: () => proxy !== undefined,
		routes,
	};
}

export async function runHostsDaemon(
	options: { service?: boolean } = {},
): Promise<void> {
	const config = readDaemonConfig();
	writeDaemonConfig(config);
	writePidfile(process.pid);

	const syncHosts = shouldSyncHostsFile();
	// Assigned by the reloader's own startProxy callback, which runs before any
	// request can arrive.
	let recoverFromStall: (ageMs: number) => void = () => {};
	const reloader = createHostsReloader({
		// Strict: an unreadable registry must reach the reloader as a failure,
		// not as an empty list it would serve as "no routes".
		pruneRoutes: () => pruneHostRoutes(undefined, { strict: true }),
		certificateFingerprint,
		describeCertificateGap,
		readCertificatePair,
		startProxy: (input) =>
			startLocalProxy({
				...input,
				httpsPort: config.httpsPort,
				httpPort:
					config.httpsPort === DEFAULT_HOSTS_DAEMON_PORT
						? config.httpPort
						: undefined,
				staleAfterMs: RELOAD_STALL_MS,
				onStale: (ageMs) => recoverFromStall(ageMs),
			}),
		syncHostsFile: syncHosts ? syncHostsFile : undefined,
		cleanHostsFile: syncHosts ? cleanHostsFile : undefined,
		log: logDaemonError,
		now: Date.now,
		onIdleExit: () => process.exit(0),
		service: options.service ?? false,
	});

	const onStop = () => {
		reloader.stop();
		const pid = readDaemonPid();
		if (pid === process.pid) {
			try {
				unlinkSync(getPidfilePath());
			} catch {
				// already gone
			}
		}
		process.exit(0);
	};
	process.on("SIGINT", onStop);
	process.on("SIGTERM", onStop);

	let consecutiveFailures = 0;
	const failureLog = createThrottledFailureLog({
		log: logDaemonError,
		now: Date.now,
	});

	// A throw here (no mkcert, :443 taken, unreadable registry) must not end the
	// process: stderr is the service log, and the next tick retries.
	async function reloadOrReport(): Promise<void> {
		try {
			await reloader.reload();
			if (consecutiveFailures > 0) {
				logDaemonError(
					`[buncargo hosts] reload recovered after ${consecutiveFailures} failed ${consecutiveFailures === 1 ? "attempt" : "attempts"}`,
				);
			}
			consecutiveFailures = 0;
			failureLog.reset();
		} catch (error) {
			consecutiveFailures += 1;
			const message = error instanceof Error ? error.message : String(error);
			failureLog.report(`[buncargo hosts] reload failed: ${message}`);
		}
	}

	/**
	 * Recover a route map that has stopped refreshing, from the request path.
	 *
	 * The loop below is the only thing that reads the registry, and a loop that
	 * stops advancing is invisible: `Bun.serve` keeps answering, so the daemon
	 * looks healthy while every named URL 404s against a frozen map. Serving a
	 * request is the one signal still known to work, so it drives the repair.
	 *
	 * Reloading in-band is tried first because it fixes the common case without
	 * dropping a single connection. Only when that does not move the timestamp
	 * does the daemon exit and let launchd/systemd `KeepAlive` restart it — a
	 * rebind costs milliseconds, and a wedged daemon costs everything.
	 */
	let recoveries = 0;
	let recovering: Promise<void> | undefined;
	recoverFromStall = (ageMs) => {
		if (recovering) return;
		logDaemonError(
			`[buncargo hosts] route map has not refreshed in ${Math.round(ageMs / 1000)}s; reloading`,
		);
		recovering = reloadOrReport()
			.then(() => {
				recoveries += 1;
				if (recoveries <= MAX_STALL_RECOVERIES) return;
				logDaemonError(
					"[buncargo hosts] route map is still stale after in-band reloads; exiting so the service restarts",
				);
				process.exit(1);
			})
			.finally(() => {
				recovering = undefined;
			});
	};

	await reloadOrReport();
	for (;;) {
		await sleep(nextReloadDelayMs(consecutiveFailures));
		await reloadOrReport();
	}
}

const HEALTH_POLL_MS = 150;
/** Budget for a user-level daemon, which only has to bind and mint. */
export const DAEMON_START_TIMEOUT_MS = 3000;
/** Budget after `hosts install` / doctor, while launchd/systemd cold-starts the unit. */
export const SERVICE_START_TIMEOUT_MS = 15_000;

/**
 * How long to poll an already-installed launchd/systemd unit.
 *
 * KeepAlive means a loaded unit is either answering or down. A routine
 * `buncargo dev` must not sit on {@link SERVICE_START_TIMEOUT_MS}; that budget
 * is only for the caller that just loaded the unit.
 */
export function resolveInstalledServiceWaitMs(timeoutMs?: number): number {
	return timeoutMs ?? 0;
}

export async function waitForDaemonHealthy(
	port: number,
	timeoutMs: number,
): Promise<boolean> {
	if (timeoutMs <= 0) {
		return isHostsDaemonHealthy(port);
	}
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await isHostsDaemonHealthy(port)) return true;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await sleep(Math.min(HEALTH_POLL_MS, remaining));
	}
}

export async function ensureHostsDaemonRunning(
	options: { allowSpawn?: boolean; timeoutMs?: number } = {},
): Promise<{ ok: boolean; message?: string }> {
	const config = readDaemonConfig();
	if (await isHostsDaemonHealthy(config.httpsPort)) {
		return { ok: true };
	}

	const serviceInstalled = isHostsServiceInstalled();
	if (!serviceInstalled) {
		const squatter = describePortSquatter(config.httpsPort);
		if (squatter) {
			return { ok: false, message: squatter };
		}
	}

	if (options.allowSpawn === false) {
		return { ok: false, message: "Named-hosts daemon is not running." };
	}

	// The system service owns :443. Spawning a user-level daemon alongside it
	// could never bind that port. KeepAlive means an already-loaded unit is
	// either answering or down — do not sit on the cold-start budget on every
	// `buncargo dev`. Callers that just loaded the unit pass timeoutMs.
	if (serviceInstalled) {
		const stale = describeStaleHostsService();
		if (stale) {
			return { ok: false, message: stale };
		}
		const waitMs = resolveInstalledServiceWaitMs(options.timeoutMs);
		if (waitMs > 0) {
			const healthy = await waitForDaemonHealthy(config.httpsPort, waitMs);
			if (healthy) return { ok: true };
		}
		return {
			ok: false,
			message: `Named-hosts service is installed but did not answer on :${config.httpsPort}. Check ${hostsServiceLogHint()}, then run \`buncargo hosts install\`.`,
		};
	}

	const bin = process.argv[1];
	if (!bin) {
		return {
			ok: false,
			message: "Could not locate the buncargo CLI to start the hosts daemon.",
		};
	}
	const child = spawn(process.execPath, [bin, "hosts", "daemon"], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();

	const healthy = await waitForDaemonHealthy(
		config.httpsPort,
		options.timeoutMs ?? DAEMON_START_TIMEOUT_MS,
	);
	return healthy
		? { ok: true }
		: {
				ok: false,
				message:
					"Named-hosts daemon did not become healthy. Run `buncargo hosts install` or use localhost:port.",
			};
}
