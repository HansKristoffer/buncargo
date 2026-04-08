import { createDevEnvironment } from "../environment";
import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import { getCachedDevEnv, setCachedDevEnv } from "./cache";
import { findConfigFile } from "./find-config-file";

export async function loadDevEnv(options?: {
	cwd?: string;
	reload?: boolean;
}): Promise<
	DevEnvironment<Record<string, ServiceConfig>, Record<string, AppConfig>>
> {
	if (!options?.reload) {
		const cached = getCachedDevEnv();
		if (cached) return cached;
	}

	const cwd = options?.cwd ?? process.cwd();
	const configPath = findConfigFile(cwd);

	if (configPath) {
		const mod = await import(configPath);
		if (!("default" in mod) || mod.default === undefined) {
			throw new Error(
				`Invalid config in "${configPath}". Use defineDevConfig() and export as default.`,
			);
		}
		const config = mod.default;

		const env = createDevEnvironment(config);
		setCachedDevEnv(env);
		return env;
	}

	throw new Error(
		"No config file found. Create dev.config.ts with: export default defineDevConfig({ ... })",
	);
}
