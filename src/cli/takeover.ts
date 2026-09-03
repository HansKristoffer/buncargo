import type { ContainerRuntimeAdapter } from "../container-runtime/types";
import { getPortOwner, killPortOwner } from "../core/process";
import { askConfirm, isInteractive } from "../core/prompt";
import { joinColoredNames } from "../core/style";
import type { AppConfig } from "../types";
import * as log from "./log";

export { isInteractive };

/**
 * Taking over apps another `buncargo dev` is already serving.
 *
 * Without this a second run in a new terminal reports "already running,
 * nothing to start" and exits, leaving the developer to find the other window
 * and Ctrl-C it. The reuse itself stays the default: taking over stops
 * somebody's running servers, so it happens only on an explicit `y` or
 * `--takeover`.
 */

export interface TakeoverCandidates {
	apps: Record<string, AppConfig>;
	names: string[];
}

/**
 * Reused apps this run could actually serve itself.
 *
 * An app without a `devCommand` is not something buncargo spawns, so stopping
 * whatever answers on its port would leave it down rather than move it here.
 */
export function takeoverCandidates(
	reusedApps: Record<string, AppConfig>,
	ports: Record<string, number>,
): TakeoverCandidates {
	const apps: Record<string, AppConfig> = {};
	for (const [name, config] of Object.entries(reusedApps)) {
		if (config.devCommand === false) continue;
		if (ports[name] === undefined) continue;
		apps[name] = config;
	}
	return { apps, names: Object.keys(apps) };
}

/**
 * Ask whether to stop the other run. Defaults to leaving it alone: a bare
 * Enter must never kill servers in a terminal the developer cannot see.
 */
export async function promptTakeover(names: string[]): Promise<boolean> {
	return askConfirm([
		`  ${joinColoredNames(names)} ${names.length === 1 ? "is" : "are"} already running from another terminal.`,
		"",
		"  y to stop it and run here  ·  Enter to leave it running",
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
	options: { runtime?: ContainerRuntimeAdapter } = {},
): Promise<string[]> {
	const stopped: string[] = [];
	for (const name of names) {
		const port = ports[name];
		if (port === undefined) continue;

		const owner = getPortOwner(port, { runtime: options.runtime });
		// Already gone: the other run exited between classification and here.
		if (!owner) continue;
		if (owner.container) {
			throw new Error(
				`App "${name}" on port ${port} is served by container ${owner.container.name}, not by a dev server this run can take over.`,
			);
		}

		const released = await killPortOwner(port, {
			runtime: options.runtime,
			verbose: false,
		});
		if (!released) {
			throw new Error(
				`Could not free port ${port} for "${name}". Stop the process holding it and try again.`,
			);
		}
		stopped.push(name);
	}

	if (stopped.length > 0) {
		log.info(`🛑 Stopped: ${joinColoredNames(stopped)}`);
	}
	return stopped;
}
