import {
	classifyPortOccupant,
	formatPortOwner,
	getPortOwner,
	isPortInUse,
} from "../core/process";
import type { AppConfig } from "../types";

/**
 * CLI-level port reuse, the counterpart to `prepareAppPort` in
 * `core/process/dev-servers.ts`. The two run at different moments and answer
 * different questions:
 *
 * - Here, before anything is spawned, a busy port means "something already
 *   serves this app". A passing `healthEndpoint` promotes it to a reuse and the
 *   app leaves the spawn set, so the spawner never sees it.
 * - There, about to bind the port, ownership decides: a container from this
 *   compose project is reused, an orphan process from this repo is killed, and
 *   anything else fails.
 *
 * Ordering makes them consistent for processes: whatever the CLI marks
 * `start` had a free port at classification time. The one case where they
 * disagreed was a *foreign container* publishing an app port — the spawner
 * fails on it while the health probe would happily reuse it — so that check
 * moves up here via {@link classifyPortOccupant}. Plain processes stay with the
 * health probe, since a sibling `buncargo dev` is a legitimate reuse and its
 * reported cwd is not a reliable owner signal.
 */
export interface ClassifiedCliApps {
	startApps: Record<string, AppConfig>;
	reusedApps: Record<string, AppConfig>;
	startNames: string[];
	reusedNames: string[];
	inferredReuseNames: string[];
}

export interface ClassifyCliAppsOptions {
	isPortBusy?: (port: number) => boolean;
	waitForServer?: (url: string, timeout?: number) => Promise<void>;
	/** Enables the foreign-container check. */
	context?: { root: string; projectName: string };
	/** Returns a message when the port owner is not ours. Injectable for tests. */
	describePortConflict?: (port: number) => string | undefined;
}

export function parseRequiredCommaSeparatedFlag(
	flag: string,
	value: string | undefined,
): string[] {
	if (value === undefined) {
		throw new Error(`Flag ${flag} requires a comma-separated value.`);
	}

	const names = value
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);

	if (names.length === 0) {
		throw new Error(`Flag ${flag} requires at least one name.`);
	}

	return names;
}

function conflictDescriber(
	options: ClassifyCliAppsOptions,
): (port: number) => string | undefined {
	if (options.describePortConflict) {
		return options.describePortConflict;
	}
	const context = options.context;
	if (!context) {
		return () => undefined;
	}
	return (port) => {
		const owner = getPortOwner(port);
		if (!owner?.container) return undefined;
		return classifyPortOccupant(owner, context) === "fail"
			? formatPortOwner(port, owner)
			: undefined;
	};
}

export async function classifyCliApps(
	apps: Record<string, AppConfig>,
	ports: Record<string, number>,
	options: ClassifyCliAppsOptions = {},
): Promise<ClassifiedCliApps> {
	const { isPortBusy = isPortInUse, waitForServer } = options;
	const describeConflict = conflictDescriber(options);
	const startApps: Record<string, AppConfig> = {};
	const reusedApps: Record<string, AppConfig> = {};
	const startNames: string[] = [];
	const reusedNames: string[] = [];
	const inferredReuseNames: string[] = [];

	for (const [name, config] of Object.entries(apps)) {
		const port = ports[name];
		if (port === undefined || !isPortBusy(port)) {
			startApps[name] = config;
			startNames.push(name);
			continue;
		}

		const conflict = describeConflict(port);
		if (conflict) {
			throw new Error(
				`App "${name}" cannot use port ${port}: ${conflict}. Stop it or change the port before running this app.`,
			);
		}

		if (config.healthEndpoint) {
			if (!waitForServer) {
				throw new Error(
					`Cannot verify health for "${name}" without a waitForServer implementation.`,
				);
			}
			const url = `http://localhost:${port}${config.healthEndpoint}`;
			try {
				await waitForServer(url, config.healthTimeout ?? 3000);
			} catch {
				throw new Error(
					`App "${name}" is already listening on port ${port}, but failed health check at ${url}. Stop the existing process or free the port before reusing it.`,
				);
			}
		} else {
			inferredReuseNames.push(name);
		}

		reusedApps[name] = config;
		reusedNames.push(name);
	}

	return {
		startApps,
		reusedApps,
		startNames,
		reusedNames,
		inferredReuseNames,
	};
}
