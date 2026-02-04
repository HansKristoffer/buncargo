import { existsSync } from "node:fs";
import { createDevEnvironment } from "./environment";
import type { AppConfig, DevEnvironment, ServiceConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Config Loader
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG_FILES = [
	"dev.config.ts",
	"dev.config.js",
	"dev-tools.config.ts",
	"dev-tools.config.js",
];

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

	for (const file of CONFIG_FILES) {
		const path = `${cwd}/${file}`;
		const exists = existsSync(path);

		if (exists) {
			const mod = await import(path);
			const config = mod.default;

			if (!config?.projectPrefix || !config?.services) {
				throw new Error(
					`Invalid config in "${file}". Use defineDevConfig() and export as default.`,
				);
			}

			cachedEnv = createDevEnvironment(config);
			return cachedEnv;
		}
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
