import { promiseTimeout } from "hanzio";
import { isTcpPortOpen } from "../network";
import { RELOAD_STALL_MS } from "./daemon";
import { readDaemonConfig, readDaemonPid } from "./daemon-config";
import {
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

/** What the running daemon reports it is serving, if it answers at all. */
export async function readHostsDaemonHealth(
	port?: number,
): Promise<ProxyHealth | undefined> {
	const config = readDaemonConfig();
	return readProxyHealth(port ?? config.httpsPort, "127.0.0.1", {
		tls: config.tls,
	});
}

export async function isHostsDaemonHealthy(port?: number): Promise<boolean> {
	return (await readHostsDaemonHealth(port)) !== undefined;
}

/**
 * A daemon that cannot serve, whether or not it answers.
 *
 * Health alone is not enough: the listener and the reload loop are independent,
 * so a daemon whose loop stopped keeps returning 200 while every named URL
 * 404s against a frozen map. Both cases want the same repair — reload it. So
 * does an outdated daemon, which the reload replaces with this version's.
 */
export async function isHostsDaemonWedged(): Promise<boolean> {
	const health = await readHostsDaemonHealth();
	if (!health || health.outdated) return true;
	return Date.now() - health.lastReloadAt > RELOAD_STALL_MS;
}

/**
 * A daemon that answers but predates the health fields every check here reads.
 * It is reported rather than served on trust: nothing it serves can be proven.
 */
export const OUTDATED_DAEMON_MESSAGE =
	"the named-hosts daemon predates this buncargo and cannot report what it serves. Run `buncargo hosts install` to update it.";

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

export type DaemonRouteCheck = { ok: true } | { ok: false; reason: string };

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
	let bindError: string | undefined;

	for (;;) {
		const health = await readHostsDaemonHealth(options.port);
		if (health !== undefined) {
			everAnswered = true;
			if (health.outdated) {
				return { ok: false, reason: OUTDATED_DAEMON_MESSAGE };
			}
			bindError = health.bindError;
			const served = new Set(health.hostnames);
			missing = hostnames.filter((hostname) => !served.has(hostname));
			if (missing.length === 0) {
				const hijack = await describeLoopbackHijack(options.port);
				return hijack ? { ok: false, reason: hijack } : { ok: true };
			}
		}

		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await promiseTimeout(Math.min(ROUTE_POLL_MS, remaining));
	}

	return {
		ok: false,
		reason: describeRouteGap({
			missing,
			everAnswered,
			bindError,
			port: readDaemonConfig().httpsPort,
		}),
	};
}

/**
 * Which failure it is matters: a daemon that never answered needs a restart,
 * one that cannot load the certificate covering these hostnames is still
 * serving the previous one, and one that answered without them has a registry
 * it is not picking up.
 */
function describeRouteGap(input: {
	missing: string[];
	everAnswered: boolean;
	bindError: string | undefined;
	port: number;
}): string {
	const names = input.missing.join(", ");
	if (!input.everAnswered)
		return `the daemon on :${input.port} stopped answering. Run \`buncargo hosts install\`.`;
	if (input.bindError !== undefined)
		return `the daemon could not load the certificate covering ${names} (${input.bindError}). Check ${hostsServiceLogHint()}, then run \`buncargo hosts install\`.`;
	return `the daemon is not serving ${names}. Run \`buncargo hosts install\`.`;
}

const HEALTH_POLL_MS = 150;
/** Budget after `hosts install` / doctor, while launchd/systemd cold-starts the unit. */
export const SERVICE_START_TIMEOUT_MS = 15_000;
/**
 * How long a routine run waits for an installed, current unit to answer.
 *
 * The daemon is briefly down after its own stall exit, while another project
 * reinstalls it, and at login. A run cannot attach later, because its apps'
 * environments are fixed at spawn, so one unanswered probe put it on
 * `localhost:port` for its whole life.
 */
export const DAEMON_RESTART_GRACE_MS = 2_000;

/** What {@link ensureHostsDaemonRunning} asks of the machine. */
export interface HostsDaemonProbe {
	healthy: () => Promise<boolean>;
	serviceInstalled: () => boolean;
	/** Why the installed unit is not this buncargo's, if it is not. */
	staleService: () => string | undefined;
	/** Whatever else holds the daemon's port, named. */
	squatter: () => string | undefined;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
}

function hostsDaemonProbe(port: number): HostsDaemonProbe {
	return {
		healthy: () => isHostsDaemonHealthy(port),
		serviceInstalled: isHostsServiceInstalled,
		staleService: describeStaleHostsService,
		squatter: () => describePortSquatter(port),
		now: Date.now,
		sleep: (ms) => promiseTimeout(ms),
	};
}

async function pollHealthy(
	probe: Pick<HostsDaemonProbe, "healthy" | "now" | "sleep">,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = probe.now() + timeoutMs;
	for (;;) {
		if (await probe.healthy()) return true;
		const remaining = deadline - probe.now();
		if (remaining <= 0) return false;
		await probe.sleep(Math.min(HEALTH_POLL_MS, remaining));
	}
}

export async function waitForDaemonHealthy(
	port: number,
	timeoutMs: number,
): Promise<boolean> {
	return pollHealthy(hostsDaemonProbe(port), timeoutMs);
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
 *
 * An installed, current unit that does not answer gets `timeoutMs`
 * ({@link DAEMON_RESTART_GRACE_MS} unless given) to come back: `KeepAlive`
 * restarts it within that.
 */
export async function ensureHostsDaemonRunning(
	options: { timeoutMs?: number } = {},
	probe: HostsDaemonProbe = hostsDaemonProbe(readDaemonConfig().httpsPort),
): Promise<{ ok: boolean; message?: string }> {
	if (await probe.healthy()) {
		return { ok: true };
	}

	if (!probe.serviceInstalled()) {
		// Naming whatever else is on the port is the whole value of this
		// message: "not running" sends someone to the wrong file.
		return {
			ok: false,
			message:
				probe.squatter() ??
				"Named-hosts service is not installed. Run `buncargo hosts install`.",
		};
	}

	const stale = probe.staleService();
	if (stale) {
		return { ok: false, message: stale };
	}

	const waitMs = options.timeoutMs ?? DAEMON_RESTART_GRACE_MS;
	if (await pollHealthy(probe, waitMs)) {
		return { ok: true };
	}

	const port = readDaemonConfig().httpsPort;
	return {
		ok: false,
		message: `Named-hosts service is installed but did not answer on :${port}. Check ${hostsServiceLogHint()}, then run \`buncargo hosts install\`.`,
	};
}
