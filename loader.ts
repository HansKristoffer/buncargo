import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createDevEnvironment } from "./environment";
import type { AppConfig, DevEnvironment, ServiceConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Config Loader
// ═══════════════════════════════════════════════════════════════════════════

export const CONFIG_FILES = [
	"dev.config.ts",
	"dev.config.js",
	"dev-tools.config.ts",
	"dev-tools.config.js",
];

/**
 * Find a config file by traversing up from the starting directory.
 * Returns the full path to the config file, or null if not found.
 */
export function findConfigFile(startDir: string): string | null {
	let currentDir = startDir;

	while (true) {
		// Check for any config file in the current directory
		for (const file of CONFIG_FILES) {
			const configPath = join(currentDir, file);
			if (existsSync(configPath)) {
				return configPath;
			}
		}

		// Move to parent directory
		const parentDir = dirname(currentDir);

		// Stop if we've reached the root (parent equals current)
		if (parentDir === currentDir) {
			return null;
		}

		currentDir = parentDir;
	}
}

let cachedEnv: DevEnvironment<
	Record<string, ServiceConfig>,
	Record<string, AppConfig>
> | null = null;

/**
 * Load the dev environment from the config file.
 * Caches the result for subsequent calls.
 *
 * @example
 * ```typescript
 * import { loadDevEnv } from 'buncargo'
 *
 * const env = await loadDevEnv()
 * console.log(env.ports.postgres)  // 5432 (or offset port)
 * console.log(env.urls.api)        // http://localhost:3000
 * ```
 */
export async function loadDevEnv(options?: {
	/** Directory to search for config file. Defaults to process.cwd() */
	cwd?: string;
	/** Skip cache and reload config */
	reload?: boolean;
}): Promise<
	DevEnvironment<Record<string, ServiceConfig>, Record<string, AppConfig>>
> {
	if (cachedEnv && !options?.reload) {
		return cachedEnv;
	}

	const cwd = options?.cwd ?? process.cwd();
	const configPath = findConfigFile(cwd);

	if (configPath) {
		const mod = await import(configPath);
		const config = mod.default;

		if (!config?.projectPrefix || !config?.services) {
			throw new Error(
				`Invalid config in "${configPath}". Use defineDevConfig() and export as default.`,
			);
		}

		cachedEnv = createDevEnvironment(config);
		return cachedEnv;
	}

	throw new Error(
		`No config file found. Create dev.config.ts with: export default defineDevConfig({ ... })`,
	);
}

/**
 * Get the cached dev environment synchronously.
 * Throws if loadDevEnv() hasn't been called yet.
 *
 * @example
 * ```typescript
 * // First load async
 * await loadDevEnv()
 *
 * // Then use sync getter anywhere
 * import { getDevEnv } from 'buncargo'
 * const env = getDevEnv()
 * ```
 */
export function getDevEnv(): DevEnvironment<
	Record<string, ServiceConfig>,
	Record<string, AppConfig>
> {
	if (!cachedEnv) {
		throw new Error("Dev environment not loaded. Call loadDevEnv() first.");
	}
	return cachedEnv;
}

/**
 * Clear the cached environment.
 */
export function clearDevEnvCache(): void {
	cachedEnv = null;
}
