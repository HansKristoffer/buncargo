import { isPortInUse } from "../core/process";
import type { AppConfig } from "../types";

export interface ClassifiedCliApps {
	startApps: Record<string, AppConfig>;
	reusedApps: Record<string, AppConfig>;
	startNames: string[];
	reusedNames: string[];
	inferredReuseNames: string[];
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

export async function classifyCliApps(
	apps: Record<string, AppConfig>,
	ports: Record<string, number>,
	options: {
		isPortBusy?: (port: number) => boolean;
		waitForServer?: (url: string, timeout?: number) => Promise<void>;
	} = {},
): Promise<ClassifiedCliApps> {
	const { isPortBusy = isPortInUse, waitForServer } = options;
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
