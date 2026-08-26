import type { AppConfig } from "../../types";
import { exec } from "./exec";

/**
 * Run production build for apps that have buildCommand configured.
 */
export function buildApps(
	apps: Record<string, AppConfig>,
	root: string,
	envVarsByApp: Record<string, Record<string, string>>,
	options: { verbose?: boolean } = {},
): void {
	const { verbose = true } = options;

	for (const [name, config] of Object.entries(apps)) {
		if (config.buildCommand) {
			if (verbose) console.log(`🔨 Building ${name}...`);

			exec(config.buildCommand, root, envVarsByApp[name] ?? {}, {
				cwd: config.cwd,
				verbose,
			});
		}
	}

	if (verbose) console.log("✓ Build complete");
}
