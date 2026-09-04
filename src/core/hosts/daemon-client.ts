import { isTcpPortOpen } from "../network";
import { sleep } from "../sleep";
import { RELOAD_STALL_MS } from "./daemon";
import { readDaemonConfig, readDaemonPid } from "./daemon-config";
import {
	isProxyHealthy,
	LOOPBACK_HOSTNAMES,
	loopbackAuthority,
	type ProxyHealth,
	readProxyHealth,
} from "./proxy";
import { describeStaleHostsService, isHostsServiceInstalled } from "./service";
import { hostsServiceLogHint } from "./service-files";
import { describePortSquatter } from "./squatter";

/**
 * Talking to the named-hosts daemon from the CLI side.
 *
 * Deliberately separate from the daemon itself. This reaches for the service
 * manifest and, to name whatever else is holding `:443`, for the container
 * runtimes — none of which belongs in the single file a root launchd job
 * executes.
 */

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

/**
 * A loopback address the browser will dial that is answered by something other
 * than our proxy, or `undefined` when every family is ours or closed.
 *
 * Health over `127.0.0.1` proves nothing about `::1`, and browsers resolve
 * `*.localhost` to both and try `::1` first. A dual-stack server on the same
 * port — Node's default `listen(443)`, Portless, Caddy — binds beside a proxy
 * that only holds one family, and its plain-HTTP answer surfaces in the
 * browser as ERR_SSL_PROTOCOL_ERROR while every CLI check passes.
 */
export async function describeLoopbackHijack(
	port?: number,
): Promise<string | undefined> {
	const config = readDaemonConfig();
	const httpsPort = port ?? config.httpsPort;
	for (const hostname of LOOPBACK_HOSTNAMES) {
		if (!(await isTcpPortOpen(httpsPort, hostname, 500))) continue;
		if (await readProxyHealth(httpsPort, hostname, { tls: config.tls })) {
			continue;
		}
		const daemonPid = readDaemonPid();
		const squatter = describePortSquatter(httpsPort, {
			ignorePids: daemonPid === undefined ? [] : [daemonPid],
		});
		return `something other than buncargo is answering on ${loopbackAuthority(hostname, httpsPort)}, which browsers try first for .localhost names. ${squatter ?? `Stop it (\`sudo lsof -nP -iTCP:${httpsPort} -sTCP:LISTEN\`) or set hosts: false.`}`;
	}
	return undefined;
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
 *
 * A probe that does not answer is retried rather than reported. The daemon
 * rebinds its listener whenever the CLI remints the certificate, which is
 * exactly what the first run in a new worktree causes, so a single unanswered
 * probe is the normal shape of a healthy startup — treating it as fatal
 * downgraded that run to `localhost:port` for no reason.
 */
export async function waitForDaemonRoutes(
	hostnames: string[],
	options: { timeoutMs?: number; port?: number } = {},
): Promise<DaemonRouteCheck> {
	if (hostnames.length === 0) return { ok: true };
	const deadline = Date.now() + (options.timeoutMs ?? ROUTE_PICKUP_TIMEOUT_MS);
	let missing: string[] = [...hostnames];
	let everAnswered = false;

	for (;;) {
		const health = await readHostsDaemonHealth(options.port);
		if (health !== undefined) {
			everAnswered = true;
			// A daemon from before this field cannot be checked. Reporting that
			// as a failure would downgrade every URL on a machine whose service
			// is simply due an upgrade, which `describeStaleHostsService`
			// already reports.
			if (health.hostnames === undefined) {
				return { ok: true, unverifiable: true };
			}
			const served = new Set(health.hostnames);
			missing = hostnames.filter((hostname) => !served.has(hostname));
			if (missing.length === 0) {
				const hijack = await describeLoopbackHijack(options.port);
				return hijack ? { ok: false, reason: hijack } : { ok: true };
			}
		}

		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await sleep(Math.min(ROUTE_POLL_MS, remaining));
	}

	// Which failure it is matters: a daemon that never answered needs a
	// restart, while one that answered without these hostnames has a registry
	// it is not picking up.
	return {
		ok: false,
		reason: everAnswered
			? `the daemon is not serving ${missing.join(", ")}. Run \`buncargo hosts install\`.`
			: `the daemon on :${readDaemonConfig().httpsPort} stopped answering. Run \`buncargo hosts install\`.`,
	};
}

const HEALTH_POLL_MS = 150;
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

/**
 * Confirm the machine's `:443` proxy is up, or say what to do about it.
 *
 * Never starts one itself. A user-level daemon could not bind `:443` alongside
 * the installed service anyway, and now that the listener sets `SO_REUSEPORT`
 * — so a reload can hand over without a gap — a second process would bind
 * *successfully* and the two would answer from separate route maps at random.
 * The service is the only thing that owns this port; every caller here reaches
 * this after `runHostsInstall` has loaded it.
 */
export async function ensureHostsDaemonRunning(
	options: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; message?: string }> {
	const config = readDaemonConfig();
	if (await isHostsDaemonHealthy(config.httpsPort)) {
		return { ok: true };
	}

	if (!isHostsServiceInstalled()) {
		// Naming whatever else is on the port is the whole value of this
		// message: "not running" sends someone to the wrong file.
		return {
			ok: false,
			message:
				describePortSquatter(config.httpsPort) ??
				"Named-hosts service is not installed. Run `buncargo hosts install`.",
		};
	}

	const stale = describeStaleHostsService();
	if (stale) {
		return { ok: false, message: stale };
	}

	// `KeepAlive` means a loaded unit is either answering or down, so a routine
	// `buncargo dev` must not sit on the cold-start budget. Only a caller that
	// just loaded the unit passes `timeoutMs`.
	const waitMs = resolveInstalledServiceWaitMs(options.timeoutMs);
	if (waitMs > 0 && (await waitForDaemonHealthy(config.httpsPort, waitMs))) {
		return { ok: true };
	}

	return {
		ok: false,
		message: `Named-hosts service is installed but did not answer on :${config.httpsPort}. Check ${hostsServiceLogHint()}, then run \`buncargo hosts install\`.`,
	};
}
