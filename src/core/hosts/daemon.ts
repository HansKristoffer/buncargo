import { statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { exponentialBackoff, getErrorMessage } from "hanzio";
// The leaf module, not `../process`: its index re-exports the port-ownership
// helpers, which reach into the container backends. The root daemon spawns
// nothing and should not carry them.
import { isProcessAlive } from "../process/lifecycle";
import { shouldSyncHostsFile } from "../runtime-flags";
import {
	certificateFingerprint,
	certificateServes,
	describeCertificateGap,
	readCertificatePair,
} from "./certificates";
import { readDaemonPid, releaseDaemonPid, writeDaemonPid } from "./daemon-pid";
import { createThrottledFailureLog } from "./failure-log";
import { cleanHostsFile, syncHostsFile } from "./hosts-file";
import { getCertPath, getRoutesPath } from "./paths";
import { isDnsHostname } from "./plan";
import { HOSTS_HTTP_PORT, HOSTS_HTTPS_PORT } from "./protocol";
import {
	type LocalProxy,
	type ProxyRouteLookup,
	type ProxyRoutesView,
	readProxyHealth,
	startLocalProxy,
} from "./proxy";
import {
	createProxyActivityRecorder,
	writeProxyActivity,
} from "./proxy-activity";
import { pruneHostRoutes } from "./registry";
import { HOSTS_SERVICE_LOG } from "./service-files";

const IDLE_EXIT_MS = 30_000;
const RELOAD_INTERVAL_MS = 1000;
/**
 * How often the certificate is checked again while nothing changes.
 *
 * Coverage only changes with a route or a remint, both of which trigger a
 * check, but expiry arrives on its own: without this a daemon up for months
 * never said its leaf was running out.
 */
export const CERTIFICATE_RECHECK_MS = 60 * 60_000;
/**
 * Ceiling on the retry interval after repeated reload failures.
 *
 * Deliberately short: a reload is a file read, and the failure log is
 * throttled separately. A CLI waiting on its routes asks for its own reload
 * (`?refresh`), but a browser hitting a route nobody refreshed for still waits
 * on the loop, so one project's problem delayed every other project's routes
 * by up to this long.
 */
const MAX_RELOAD_BACKOFF_MS = 5_000;

/**
 * How long without a finished reload before the loop is presumed stopped.
 *
 * Comfortably above {@link MAX_RELOAD_BACKOFF_MS} so a daemon that is merely
 * backing off through a run of failures is not mistaken for a dead one.
 */
export const RELOAD_STALL_MS = 45_000;

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
	return exponentialBackoff(consecutiveFailures, {
		baseMs: RELOAD_INTERVAL_MS,
		maxMs: MAX_RELOAD_BACKOFF_MS,
		jitter: false,
	});
}

/**
 * How long without a finished reload before the daemon gives up and exits for
 * the supervisor to restart it.
 *
 * Twice {@link RELOAD_STALL_MS}: a stall gets an in-band reload from the first
 * request that notices it, and only one that a full stall window of those did
 * not repair ends in an exit. An exit drops every proxied websocket on the
 * machine, so a stall a reload fixed must never add up to one; and since any
 * finished reload resets the age, it cannot.
 */
export const STALLED_EXIT_MS = 2 * RELOAD_STALL_MS;

/**
 * What the request path does about a route map that has stopped refreshing.
 *
 * The request path, not a timer: the failure this catches is a loop whose
 * scheduling stopped, and a watchdog on the same timers would stop with it.
 * The reload joins one already in flight, so a reload that hangs is not
 * stacked on; the exit is what gets the daemon past it.
 */
export function createStallHandler(input: {
	reload: () => void;
	log: (message: string) => void;
	exit: (code: number) => void;
}): (ageMs: number) => void {
	return (ageMs) => {
		const seconds = Math.round(ageMs / 1000);
		if (ageMs > STALLED_EXIT_MS) {
			input.log(
				`[buncargo hosts] route map has not refreshed in ${seconds}s despite in-band reloads; exiting so the service restarts`,
			);
			input.exit(1);
			return;
		}
		input.log(
			`[buncargo hosts] route map has not refreshed in ${seconds}s; reloading`,
		);
		input.reload();
	};
}

/**
 * Keep the service log from growing without bound.
 *
 * It is append-only and the daemon runs for weeks; a version that crash-looped
 * left 800KB of one repeated line on this machine, which is both useless and
 * the first thing anyone opens when named hosts break. Truncating at startup
 * bounds it without a rotation scheme, and the interesting lines are the ones
 * after the most recent start anyway.
 */
export function truncateOversizedLog(
	path: string,
	maxBytes = MAX_SERVICE_LOG_BYTES,
): void {
	try {
		if (statSync(path).size <= maxBytes) return;
		// Truncate rather than unlink: launchd and systemd hold this file open,
		// and replacing it would leave them writing to an unlinked inode.
		truncateSync(path, 0);
		writeFileSync(
			path,
			`[buncargo hosts] earlier log truncated at ${new Date().toISOString()}\n`,
			{ flag: "a" },
		);
	} catch {
		// Not our log to manage (no such file, not permitted): leave it.
	}
}

/** Above this, the log is more noise than history. */
const MAX_SERVICE_LOG_BYTES = 5_000_000;

/** Every way the daemon ends on purpose: leave no state naming this process. */
function exitDaemon(code: number): never {
	try {
		releaseDaemonPid(process.pid);
	} catch {
		// best-effort: readers check the pid is alive before trusting it
	}
	process.exit(code);
}

type HostsReloadReason = "startup" | "poll" | "refresh" | "recovery" | "manual";

export interface HostsReloaderDeps {
	/** Optional diagnostics; never printed on the ordinary reload path. */
	onReload?: (event: { reason: HostsReloadReason; count: number }) => void;
	pruneRoutes: () => Promise<
		Array<{ hostname: string; port: number; root: string }>
	>;
	/**
	 * A request was proxied to a route of this checkout: what a detached
	 * run's idle limit counts (`proxy-activity.ts`).
	 */
	onRequest: (root: string) => void;
	certificateFingerprint: () => string;
	describeCertificateGap: (hostnames: string[]) => string | undefined;
	/** `undefined` while a mint holds the pair: try again on a later pass. */
	readCertificatePair: () => Promise<{ cert: string; key: string } | undefined>;
	/**
	 * Which hostnames a bound certificate answers for
	 * ({@link certificateServes}); `undefined` when it cannot be read.
	 */
	certificateServes: (
		cert: string,
	) => ((hostname: string, now: number) => boolean) | undefined;
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
	/** Reload, or join the reload already running. */
	reload: (reason?: HostsReloadReason) => Promise<void>;
	/**
	 * A reload that starts after this call: one already running may have read
	 * the registry before the caller's write landed. Callers arriving together
	 * share it.
	 */
	refresh: () => Promise<void>;
	stop: () => void;
	/** Whether a listener is currently bound. */
	isBound: () => boolean;
	/**
	 * What the proxy reports: the hostnames the bound listener answers for, the
	 * last refresh time, and why a rebind is failing.
	 */
	routes: () => ProxyRoutesView;
}

/**
 * The daemon's one job, with every edge injected.
 *
 * Kept separate from {@link runHostsDaemon} so the rebind rule can be tested
 * without binding a port, minting a certificate or waiting on real time.
 */
export function createHostsReloader(deps: HostsReloaderDeps): HostsReloader {
	const routeMap = new Map<string, { port: number; root: string }>();
	let proxy: LocalProxy | undefined;
	let inFlight: Promise<void> | undefined;
	let queuedRefresh: Promise<void> | undefined;
	let stopped = false;
	let reloadCount = 0;
	let lastHostKey = "";
	let lastCertKey = "";
	let idleSince: number | undefined;
	let lastHostsFileFailure: string | undefined;
	let lastCertificateGap: string | undefined;
	let lastInvalidHostnames = "";
	let lastRedirectError: string | undefined;
	let lastGapCheckAt = Number.NEGATIVE_INFINITY;
	// What the listener actually serves. Nothing until the first bind, and
	// only advanced by a bind that succeeded: a route in the map that the
	// bound leaf does not cover is not served, whatever the map says.
	let serves: (hostname: string, now: number) => boolean = () => false;
	let bindError: string | undefined;
	// Seeded rather than left undefined: a daemon that has not finished its
	// first reload is starting up, not frozen.
	let lastReloadAt = deps.now();

	// Every proxied request and WebSocket upgrade looks its route up here,
	// and the health path does not, so this is where a request is counted.
	const lookup: ProxyRouteLookup = (hostname) => {
		const route = routeMap.get(hostname);
		if (route) deps.onRequest(route.root);
		return route?.port;
	};
	// `hostnames` is a getter: every proxied request reads this view, and only
	// health and a 404 read the list.
	const routes = (): ProxyRoutesView => {
		const now = deps.now();
		return {
			get hostnames() {
				return [...routeMap.keys()].filter((hostname) => serves(hostname, now));
			},
			lastReloadAt,
			...(bindError === undefined ? {} : { bindError }),
		};
	};

	/**
	 * An unwritable `/etc/hosts` stops named hostnames resolving, so it cannot
	 * stay silent. It also must not fail the reload or spam once a second, so
	 * it is reported once per distinct cause.
	 */
	function reportHostsFileFailure(action: string, error: unknown): void {
		const message = getErrorMessage(error);
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

	/**
	 * A hostname that is not a DNS name never reaches the map or `/etc/hosts`:
	 * `routes.json` is user-writable and this process is root, so a newline in
	 * one would be lines of the user's choosing in the hosts file. Logged once
	 * per distinct set, since the file is read every second.
	 */
	function servableRoutes(
		loaded: Awaited<ReturnType<HostsReloaderDeps["pruneRoutes"]>>,
	): typeof loaded {
		const servable = loaded.filter((route) => isDnsHostname(route.hostname));
		const invalid = loaded
			.filter((route) => !servable.includes(route))
			.map((route) => JSON.stringify(route.hostname))
			.join(", ");
		if (invalid !== "" && invalid !== lastInvalidHostnames) {
			deps.log(
				`[buncargo hosts] ignoring routes whose hostname is not a DNS name: ${invalid}. Remove them from ${getRoutesPath()}.`,
			);
		}
		lastInvalidHostnames = invalid;
		return servable;
	}

	async function performReload(reason: HostsReloadReason): Promise<void> {
		if (stopped) return;
		reloadCount += 1;
		deps.onReload?.({ reason, count: reloadCount });
		// Load before clearing, so a registry that could not be read leaves the
		// previous map serving. An unreadable file is not a file with no routes,
		// and clearing first would 404 every named URL on the machine.
		const loaded = servableRoutes(await deps.pruneRoutes());
		if (stopped) return;
		routeMap.clear();
		for (const route of loaded) {
			routeMap.set(route.hostname, { port: route.port, root: route.root });
		}
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
		const recheckDue = deps.now() - lastGapCheckAt >= CERTIFICATE_RECHECK_MS;
		if (!mustBind && hostKey === lastHostKey && !recheckDue) {
			return;
		}

		// Minting belongs to the CLI, which runs as the user and can find
		// mkcert. A hostname the leaf does not cover fails TLS for that
		// hostname alone, so report it and serve the rest: failing the whole
		// reload put the daemon into a widening backoff, which delayed picking
		// up every *other* project's routes because one worktree was uncovered.
		reportCertificateGap(deps.describeCertificateGap(hostnames));
		lastGapCheckAt = deps.now();

		lastHostKey = hostKey;
		if (!mustBind) return;

		try {
			await rebind(certKey);
		} catch (error) {
			// Health says so: the routes it lists are only those the previous
			// leaf covers, and the CLI names this as the reason the rest are not.
			bindError = getErrorMessage(error);
			throw error;
		}
	}

	async function rebind(certKey: string): Promise<void> {
		// Read before stopping: an unreadable pair should leave the running
		// listener alone rather than take every named URL down first.
		const pair = await deps.readCertificatePair();
		// A mint in progress. `lastCertKey` stays put, so the next pass, or the
		// rename that lands the mint, rebinds.
		if (!pair || stopped) return;
		const { cert, key } = pair;

		// Bind the replacement *before* dropping the old listener. Both hold
		// the port at once under SO_REUSEPORT and the kernel hands new
		// connections to the new one, so there is no instant where nothing
		// answers on :443. Stopping first left exactly that window, and a CLI
		// health probe landing in it — which the remint for a new worktree's
		// hostnames makes likely — reported the daemon as down.
		//
		// A throw here therefore leaves the previous listener serving, and
		// `lastCertKey` unadvanced so the next reload retries.
		const next = await deps.startProxy({
			lookup,
			routes,
			cert,
			key,
		});
		if (stopped) {
			next.stop();
			return;
		}
		const previous = proxy;
		proxy = next;
		previous?.stop();
		lastCertKey = certKey;
		reportRedirectError(next.redirectError);
		const leafServes = deps.certificateServes(cert);
		// The listener took it, so it serves something: list the route map
		// rather than nothing, which would put every run on `localhost:port`.
		// Logged once per bind, which is once per certificate.
		if (leafServes === undefined) {
			const message = `[buncargo hosts] could not read the names or expiry of the certificate the listener bound (${getCertPath()}); health lists every route. If named URLs fail TLS, run \`buncargo hosts install\`.`;
			deps.log(message);
		}
		serves = leafServes ?? (() => true);
		// Only a bind that succeeded clears it: a pass that found a mint in
		// progress bound nothing, and the failure it would hide still stands.
		bindError = undefined;
	}

	/**
	 * `:80` only redirects to https, so the listener serves without it. Said
	 * once per cause: every remint binds again and meets the same holder.
	 */
	function reportRedirectError(error: string | undefined): void {
		if (error === lastRedirectError) return;
		lastRedirectError = error;
		if (error === undefined) return;
		deps.log(
			`[buncargo hosts] serving https without the http:// redirect: ${error}`,
		);
	}

	function reload(reason: HostsReloadReason = "manual"): Promise<void> {
		// The poll, a CLI's refresh and in-request recovery share this
		// operation. Every reload that finishes advances `lastReloadAt`,
		// failed or not: it says the loop is running. Advanced on success
		// alone, a registry the daemon could not read (corrupt, or written by
		// a newer CLI) read as a stalled loop, and stall recovery exited a
		// daemon that a restart could not help.
		inFlight ??= performReload(reason).finally(() => {
			lastReloadAt = deps.now();
			inFlight = undefined;
		});
		return inFlight;
	}

	function refresh(): Promise<void> {
		const running = inFlight;
		if (!running) return reload("refresh");
		queuedRefresh ??= running
			.catch(() => {})
			.then(() => {
				queuedRefresh = undefined;
				return reload("refresh");
			});
		return queuedRefresh;
	}

	return {
		reload,
		refresh,
		stop: () => {
			stopped = true;
			proxy?.stop();
			proxy = undefined;
		},
		isBound: () => proxy !== undefined,
		routes,
	};
}

export async function runHostsDaemon(
	options: { service?: boolean } = {},
): Promise<void> {
	const service = options.service ?? false;

	// The listener sets SO_REUSEPORT so a reload can bind its replacement before
	// dropping the old one. That also means a second daemon would bind happily
	// alongside the first rather than failing, and the two would answer from
	// separate route maps at random. Refuse instead.
	//
	// Only on the foreground path: under launchd/systemd `KeepAlive` an exit
	// here would be respawned immediately, and the supervisor already
	// guarantees a single instance.
	if (!service) {
		const other = readDaemonPid();
		if (
			other !== undefined &&
			other !== process.pid &&
			isProcessAlive(other) &&
			(await readProxyHealth(HOSTS_HTTPS_PORT)) !== undefined
		) {
			logDaemonError(
				`[buncargo hosts] a daemon is already serving :${HOSTS_HTTPS_PORT} (pid ${other}); nothing to do`,
			);
			return;
		}
	}

	if (service) truncateOversizedLog(HOSTS_SERVICE_LOG);

	writeDaemonPid(process.pid);

	const syncHosts = shouldSyncHostsFile();
	const activity = createProxyActivityRecorder({
		write: (seen, now) => writeProxyActivity(seen, now),
		now: Date.now,
	});
	let consecutiveFailures = 0;
	const failureLog = createThrottledFailureLog({
		log: logDaemonError,
		now: Date.now,
	});

	// A throw here (no mkcert, :443 taken, unreadable registry) must not end the
	// process: stderr is the service log, and the next tick retries.
	async function reloadOrReport(run: () => Promise<void>): Promise<void> {
		try {
			await run();
			if (consecutiveFailures > 0) {
				logDaemonError(
					`[buncargo hosts] reload recovered after ${consecutiveFailures} failed ${consecutiveFailures === 1 ? "attempt" : "attempts"}`,
				);
			}
			consecutiveFailures = 0;
			failureLog.reset();
		} catch (error) {
			consecutiveFailures += 1;
			const message = getErrorMessage(error);
			failureLog.report(`[buncargo hosts] reload failed: ${message}`);
		}
	}

	// The loop below is the only thing that reads the registry unasked, and a
	// loop that stops advancing is invisible: `Bun.serve` keeps answering, so
	// the daemon looks healthy while every named URL 404s against a frozen map.
	// Serving a request is the one signal still known to work, so it drives
	// the repair.
	const onStale = createStallHandler({
		reload: () => void reloadOrReport(() => reloader.reload("recovery")),
		log: logDaemonError,
		exit: exitDaemon,
	});
	const reloader: HostsReloader = createHostsReloader({
		// Strict: an unreadable registry must reach the reloader as a failure,
		// not as an empty list it would serve as "no routes".
		pruneRoutes: () => pruneHostRoutes({ strict: true }),
		certificateFingerprint,
		describeCertificateGap,
		readCertificatePair,
		certificateServes,
		startProxy: ({ cert, key, ...input }) =>
			startLocalProxy({
				...input,
				tls: { cert, key },
				httpsPort: HOSTS_HTTPS_PORT,
				httpPort: HOSTS_HTTP_PORT,
				refresh: () => reloadOrReport(() => reloader.refresh()),
				staleAfterMs: RELOAD_STALL_MS,
				onStale,
			}),
		syncHostsFile: syncHosts ? syncHostsFile : undefined,
		cleanHostsFile: syncHosts ? cleanHostsFile : undefined,
		log: logDaemonError,
		now: Date.now,
		onIdleExit: () => exitDaemon(0),
		onRequest: activity.note,
		service,
	});

	const onStop = () => {
		reloader.stop();
		exitDaemon(0);
	};
	process.on("SIGINT", onStop);
	process.on("SIGTERM", onStop);

	await reloadOrReport(() => reloader.reload("startup"));
	await activity.flush();
	for (;;) {
		// The poll picks up what nobody asked about: routes whose owner died,
		// which no write announces, and registrations by anything that does not
		// ask for a refresh.
		await Bun.sleep(nextReloadDelayMs(consecutiveFailures));
		await reloadOrReport(() => reloader.reload("poll"));
		await activity.flush();
	}
}
