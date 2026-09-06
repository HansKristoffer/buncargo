import type { AppConfig } from "../../types";
import { exec, execAsync } from "./exec";

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

/** Cancellable builds for startup; the synchronous export remains compatible. */
export async function buildAppsAsync(
	apps: Record<string, AppConfig>,
	root: string,
	envVarsByApp: Record<string, Record<string, string>>,
	options: { verbose?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
	const { verbose = true } = options;
	for (const [name, config] of Object.entries(apps)) {
		options.signal?.throwIfAborted();
		if (!config.buildCommand) continue;
		if (verbose) console.log(`🔨 Building ${name}...`);
		await execAsync(config.buildCommand, root, envVarsByApp[name] ?? {}, {
			cwd: config.cwd,
			verbose,
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? 600000,
		});
	}
	if (verbose) console.log("✓ Build complete");
}
