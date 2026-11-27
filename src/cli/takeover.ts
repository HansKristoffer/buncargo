import type { ContainerRuntimeAdapter } from "../container-runtime/types";
import {
	createPortOwnerSnapshotAsync,
	killPortOwnerFoundBy,
} from "../core/process";
import { stopWorker } from "../core/process/worker-ownership";
import { askConfirm } from "../core/prompt";
import { joinColoredNames } from "../core/style";
import type { ResolvedApp } from "../types";
import * as log from "./log";

// Taking over apps another `buncargo dev` is already serving.
//
// Without this a second run in a new terminal reports "already running,
// nothing to start" and exits, leaving the developer to find the other window
// and Ctrl-C it. Reuse stays the default: taking over stops somebody's running
// servers, so it happens only on an explicit `y` or `--takeover`.

export interface TakeoverCandidates {
	apps: Record<string, ResolvedApp>;
	names: string[];
}

/**
 * Reused apps this run could actually serve itself.
 *
 * An app without a `devCommand` is not something buncargo spawns, so stopping
 * whatever answers on its port would leave it down rather than move it here.
 */
export function takeoverCandidates(
	reusedApps: Record<string, ResolvedApp>,
	ports: Record<string, number>,
): TakeoverCandidates {
	const apps: Record<string, ResolvedApp> = {};
	for (const [name, config] of Object.entries(reusedApps)) {
		if (config.devCommand === false) continue;
		if (ports[name] === undefined && config.port !== undefined) continue;
		apps[name] = config;
	}
	return { apps, names: Object.keys(apps) };
}

/**
 * Ask whether to stop the other run. Defaults to leaving it alone: a bare
 * Enter must never kill servers in a terminal the developer cannot see.
 */
export async function promptTakeover(names: string[]): Promise<boolean> {
	const verb = names.length === 1 ? "is" : "are";
	return askConfirm([
		`  ${joinColoredNames(names)} ${verb} already running from another terminal.`,
		"",
		"  y to stop it and run here  ·  Enter to leave it running",
	]);
}

/**
 * Ask whether to replace another run's servers that fail their health check.
 * Enter cancels this run: reusing them would serve the broken server.
 */
export async function promptUnhealthyTakeover(
	names: string[],
): Promise<boolean> {
	const one = names.length === 1;
	const verb = one ? "is" : "are";
	const failure = one ? "fails its" : "fail their";
	return askConfirm([
		`  ${joinColoredNames(names)} ${verb} running from another terminal, but ${failure} health check.`,
		"",
		"  y to stop it and run here  ·  Enter to cancel",
	]);
}

/**
 * Stop whatever serves each app's port, so this run can bind it.
 *
 * The other `buncargo dev` notices its servers exit and tears itself down: it
 * drops only the host routes carrying its own pid, which this run has already
 * overwritten, and hands the containers to the watchdog's idle backstop rather
 * than stopping them.
 */
export async function stopRunningApps(
	names: string[],
	ports: Record<string, number>,
	options: {
		runtime?: ContainerRuntimeAdapter;
		skipContainers?: boolean;
		root?: string;
		apps?: Record<string, ResolvedApp>;
	} = {},
): Promise<string[]> {
	const workerNames: string[] = [];
	const portTargets: { name: string; port: number; stopGraceMs?: number }[] =
		[];

	for (const name of names) {
		const app = options.apps?.[name];
		// A worker has no port: it is stopped through the worker registry, not by its port.
		if (app && app.port === undefined && options.root) {
			workerNames.push(name);
			continue;
		}
		const port = ports[name];
		if (port !== undefined) {
			portTargets.push({ name, port, stopGraceMs: app?.stopGraceMs });
		}
	}

	// Take one port-owner snapshot across every port target, then stop them
	// concurrently so multi-app takeover does not pay N serial grace waits.
	const snapshot =
		portTargets.length > 0
			? await createPortOwnerSnapshotAsync({
					runtime: options.runtime,
					skipContainers: options.skipContainers,
					ports: portTargets.map((t) => t.port),
					includeCwd: false,
				})
			: undefined;

	for (const { name, port } of portTargets) {
		const owner = snapshot?.owner(port);
		if (owner?.kind === "container") {
			throw new Error(
				`App "${name}" on port ${port} is served by container ${owner.container.name}, not by a dev server this run can take over.`,
			);
		}
	}

	const root = options.root;
	const [workerResults, portResults] = await Promise.all([
		Promise.all(
			workerNames.map(async (name) =>
				root && (await stopWorker(root, name)) ? name : undefined,
			),
		),
		Promise.all(
			portTargets.map(async ({ name, port, stopGraceMs }) => {
				const owner = snapshot?.owner(port) ?? null;
				// Already gone: the other run exited between classification and here.
				if (!owner) return undefined;
				const released = await killPortOwnerFoundBy(async () => owner, port, {
					runtime: options.runtime,
					skipContainers: options.skipContainers,
					verbose: false,
					timeout: stopGraceMs,
				});
				if (!released) {
					throw new Error(
						`Could not free port ${port} for "${name}". Stop the process holding it and try again.`,
					);
				}
				return name;
			}),
		),
	]);

	const stopped = [...workerResults, ...portResults].filter(
		(name): name is string => name !== undefined,
	);

	if (stopped.length > 0) {
		log.info(`🛑 Stopped: ${joinColoredNames(stopped)}`);
	}
	return stopped;
}
