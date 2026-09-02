import {
	type FSWatcher,
	mkdirSync,
	statSync,
	truncateSync,
	unlinkSync,
	watch,
	writeFileSync,
	writeSync,
} from "node:fs";
// The leaf module, not `../process`: its index re-exports the port-ownership
// helpers, which reach into the container backends. The root daemon spawns
// nothing and should not carry them.
import { isProcessAlive } from "../process/lifecycle";
import {
	DEFAULT_HOSTS_DAEMON_PORT,
	shouldSyncHostsFile,
} from "../runtime-flags";
import {
	certificateFingerprint,
	describeCertificateGap,
	readCertificatePair,
} from "./certificates";
import {
	readDaemonConfig,
	readDaemonPid,
	writeDaemonConfig,
} from "./daemon-config";
import { cleanHostsFile, syncHostsFile } from "./hosts-file";
import {
	chownToInvokingUser,
	getCertsDir,
	getHostsStateDir,
	getPidfilePath,
} from "./paths";
import {
	type LocalProxy,
	type ProxyRouteLookup,
	type ProxyRoutesView,
	readProxyHealth,
	startLocalProxy,
} from "./proxy";
import { pruneHostRoutes } from "./registry";
import { HOSTS_SERVICE_LOG } from "./service-files";

const _DEFAULT_HTTP_PORT = 80;
const IDLE_EXIT_MS = 30_000;
const RELOAD_INTERVAL_MS = 1000;
/**
 * Ceiling on the retry interval after repeated reload failures.
 *
 * Deliberately short: a reload is a file read, the failure log is throttled
 * separately, and {@link watchHostsState} means the loop is a backstop rather
 * than the primary trigger. A longer ceiling meant one project's problem
 * delayed picking up every other project's routes by up to that long.
 */
const MAX_RELOAD_BACKOFF_MS = 5_000;

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

export interface ReloadWakeup {
	/** Ask the next {@link ReloadWakeup.wait} to return immediately. */
	signal(): void;
	/** Resolve on the next signal, or after `ms`, whichever comes first. */
	wait(ms: number): Promise<void>;
}

/**
 * The reload loop's sleep, interruptible by a filesystem event.
 *
 * A signal that arrives while nothing is waiting is remembered, so a change
 * landing mid-reload still causes the following pass rather than being lost
 * between the two.
 */
export function createReloadWakeup(): ReloadWakeup {
	let wake: (() => void) | undefined;
	let pending = false;

	return {
		signal() {
			pending = true;
			const resume = wake;
			wake = undefined;
			resume?.();
		},
		async wait(ms: number): Promise<void> {
			if (pending) {
				pending = false;
				return;
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					wake = undefined;
					resolve();
				}, ms);
				wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			pending = false;
		},
	};
}

/**
 * Collapse a burst of filesystem events into one callback.
 *
 * An atomic write is a create plus a rename, and a mint lands two files, so a
 * single logical change arrives as several events. Without the debounce the
 * daemon would reload once per event.
 */
export function createDebouncedTrigger(deps: {
	onTrigger: () => void;
	debounceMs: number;
}): { fire: () => void; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		fire() {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = undefined;
				deps.onTrigger();
			}, deps.debounceMs);
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

/** How long to coalesce filesystem events before reloading. */
export const WATCH_DEBOUNCE_MS = 20;

/**
 * Reload as soon as the registry or the certificate changes, instead of on the
 * next poll.
 *
 * Polling alone put 0-1000ms of pure waiting into every `buncargo dev` before
 * its hostnames could be advertised, which is paid on every run in every
 * worktree. Watching the directories rather than the files is deliberate:
 * writes land through a temp file and a rename, so the inode a file watch was
 * holding is not the one that ends up in place.
 *
 * Best-effort by construction — a platform or filesystem where this does not
 * work simply falls back to the poll, which is still running.
 */
export function watchHostsState(deps: {
	directories: string[];
	onChange: () => void;
	log: (message: string) => void;
	debounceMs?: number;
}): () => void {
	const trigger = createDebouncedTrigger({
		onTrigger: deps.onChange,
		debounceMs: deps.debounceMs ?? WATCH_DEBOUNCE_MS,
	});
	const watchers: FSWatcher[] = [];

	for (const directory of deps.directories) {
		try {
			mkdirSync(directory, { recursive: true });
			chownToInvokingUser(directory);
			const watcher = watch(directory, () => trigger.fire());
			// A watcher that errors later must not take the daemon down; the
			// poll covers it.
			watcher.on("error", () => {});
			watchers.push(watcher);
		} catch (error) {
			deps.log(
				`[buncargo hosts] could not watch ${directory}, falling back to polling: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	return () => {
		trigger.cancel();
		for (const watcher of watchers) {
			try {
				watcher.close();
			} catch {
				// already closed
			}
		}
	};
}

function writePidfile(pid: number): void {
	mkdirSync(getHostsStateDir(), { recursive: true });
	const path = getPidfilePath();
	writeFileSync(path, `${pid}\n`);
	chownToInvokingUser(path);
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
		const previous = proxy;
		proxy = next;
		previous?.stop();
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
			(await readProxyHealth(config.httpsPort, "127.0.0.1", {
				tls: config.tls,
			})) !== undefined
		) {
			logDaemonError(
				`[buncargo hosts] a daemon is already serving :${config.httpsPort} (pid ${other}); nothing to do`,
			);
			return;
		}
	}

	if (service) truncateOversizedLog(HOSTS_SERVICE_LOG);

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
		service,
	});

	const wakeup = createReloadWakeup();
	const stopWatching = watchHostsState({
		// The registry and the certificate: the two inputs a reload reads.
		directories: [getHostsStateDir(), getCertsDir()],
		onChange: () => wakeup.signal(),
		log: logDaemonError,
	});

	const onStop = () => {
		stopWatching();
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
		// Whichever comes first: a change on disk, or the poll. The poll is the
		// backstop — it is also what prunes routes whose owner died, which no
		// filesystem event announces.
		await wakeup.wait(nextReloadDelayMs(consecutiveFailures));
		await reloadOrReport();
	}
}
