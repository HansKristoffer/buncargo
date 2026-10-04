import type { AppConfig } from "../../types";
import { execAsync } from "./exec";

/** Run each app's `buildCommand`, one at a time; cancellable. */
export async function buildApps(
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
