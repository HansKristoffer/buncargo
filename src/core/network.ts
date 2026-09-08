import net from "node:net";
import { networkInterfaces } from "node:os";
import type { AppConfig } from "../types";
import { abortableSleep, remainingTime, withDeadline } from "./deadline";
import { recordStartupMetric } from "./startup-metrics";
import {
	formatDone,
	formatUrl,
	formatWait,
	SLOW_STEP_MS,
	scheduleLog,
} from "./style";

// ═══════════════════════════════════════════════════════════════════════════
// Local IP Detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Gets the local IP address of the machine for mobile device connectivity.
 * Prefers IPv4 addresses on non-internal interfaces.
 */
export function getLocalIp(): string {
	const interfaces = networkInterfaces();

	for (const name of Object.keys(interfaces)) {
		const nets = interfaces[name];
		if (!nets) continue;

		for (const net of nets) {
			// Skip internal (loopback) addresses
			if (net.family === "IPv4" && !net.internal) {
				return net.address;
			}
		}
	}

	return "127.0.0.1";
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP Health Checks
// ═══════════════════════════════════════════════════════════════════════════

export interface WaitForServerOptions {
	/** Timeout in milliseconds */
	timeout?: number;
	/** Polling interval in milliseconds */
	interval?: number;
	/** Cancel readiness and outstanding probes. */
	signal?: AbortSignal;
	/** Require a successful HTTP response (explicit app endpoints use this). */
	strict?: boolean;
	/** Log progress */
	verbose?: boolean;
}

/**
 * Wait for an HTTP server to respond.
 */
export async function waitForServer(
	url: string,
	options: WaitForServerOptions = {},
): Promise<void> {
	const {
		timeout = 30000,
		interval = 200,
		verbose = false,
		signal,
		strict = false,
	} = options;
	const deadline = performance.now() + timeout;
	let attempts = 0;
	while (remainingTime(deadline) > 0) {
		signal?.throwIfAborted();
		if (attempts > 0) recordStartupMetric("healthRetries");
		attempts++;
		try {
			const ready = await withDeadline(
				async (probeSignal) => {
					const response = await fetch(url, { signal: probeSignal });
					const healthy = response.ok || (!strict && response.status === 404);
					await response.body?.cancel();
					return healthy;
				},
				Math.min(5000, remainingTime(deadline)),
				signal,
			);
			if (ready) {
				if (verbose && attempts >= 5)
					console.log(
						formatDone(`${formatUrl(url)} ready after ${attempts} attempts`),
					);
				return;
			}
		} catch {
			signal?.throwIfAborted();
		}
		await abortableSleep(Math.min(interval, remainingTime(deadline)), signal);
	}
	signal?.throwIfAborted();
	throw new Error(
		`Server at ${url} did not respond within ${timeout}ms after ${attempts} attempts`,
	);
}

/**
 * Wait for all dev servers to be ready.
 */
export async function waitForDevServers(
	apps: Record<string, AppConfig>,
	ports: Record<string, number>,
	options: {
		timeout?: number;
		verbose?: boolean;
		productionBuild?: boolean;
		signal?: AbortSignal;
		onAppReady?: (name: string) => void;
	} = {},
): Promise<void> {
	const { timeout = 60000, verbose = true } = options;
	const controller = new AbortController();
	const cancel = () => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) cancel();
	else options.signal?.addEventListener("abort", cancel, { once: true });

	let showedWait = false;
	const cancelWait = verbose
		? scheduleLog(SLOW_STEP_MS, () => {
				showedWait = true;
				console.log(formatWait("Waiting for servers to be ready..."));
			})
		: () => {};

	const promises: Promise<void>[] = [];

	for (const [name, config] of Object.entries(apps)) {
		if (
			config.kind === "worker" ||
			config.healthEndpoint === false ||
			(config.devCommand === false &&
				!(options.productionBuild && config.prodCommand))
		) {
			continue;
		}
		const port = ports[name];
		const healthPath = config.healthEndpoint ?? "/";
		const url = `http://localhost:${port}${healthPath}`;
		const appTimeout = config.healthTimeout ?? timeout;

		promises.push(
			waitForServer(url, {
				timeout: appTimeout,
				verbose,
				signal: controller.signal,
				strict: config.healthEndpoint !== undefined,
			}).then(() => {
				options.onAppReady?.(name);
			}),
		);
	}

	try {
		await Promise.all(promises);
	} finally {
		controller.abort();
		options.signal?.removeEventListener("abort", cancel);
		cancelWait();
	}

	if (showedWait) console.log(formatDone("All servers ready"));
}

// ═══════════════════════════════════════════════════════════════════════════
// Port Availability
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Probe whether something is accepting TCP connections on `port`.
 *
 * This answers "is it reachable", not "who owns it". For ownership decisions
 * (reuse/kill/fail) use `getPortOwner` from `core/process`, which inspects
 * listening PIDs and Docker labels instead.
 */
export function isTcpPortOpen(
	port: number,
	host = "127.0.0.1",
	timeoutMs = 1000,
	signal?: AbortSignal,
): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);
		const socket = net.connect({ port, host });
		const finish = (open: boolean) => {
			signal?.removeEventListener("abort", onAbort);
			socket.removeAllListeners();
			socket.destroy();
			resolve(open);
		};
		const onAbort = () => finish(false);
		signal?.addEventListener("abort", onAbort, { once: true });
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));
	});
}

/**
 * Inverse of {@link isTcpPortOpen}: nothing is accepting connections on `port`.
 *
 * Note this is a reachability check. A port can look "available" here while
 * still being held by a process that is not yet listening, so prefer
 * `isPortInUse`/`getPortOwner` when deciding whether to bind or kill.
 */
export async function isPortAvailable(port: number): Promise<boolean> {
	return !(await isTcpPortOpen(port));
}
