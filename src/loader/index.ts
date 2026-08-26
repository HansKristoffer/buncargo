import type { AnyDevConfig, DevConfigLike, DevEnvironmentFor } from "../types";
import { getCachedDevEnv } from "./cache";

export { clearDevEnvCache } from "./cache";
export { CONFIG_FILES, findConfigFile } from "./find-config-file";
export { loadDevEnv } from "./load-dev-env";

/**
 * Get the environment already built by {@link loadDevEnv}.
 *
 * Takes the same optional config type parameter so inference survives:
 * `getDevEnv<typeof devConfig>()`.
 */
export function getDevEnv<
	TConfig extends DevConfigLike = AnyDevConfig,
>(): DevEnvironmentFor<TConfig> {
	const env = getCachedDevEnv();
	if (!env) {
		throw new Error("Dev environment not loaded. Call loadDevEnv() first.");
	}
	return env as DevEnvironmentFor<TConfig>;
}
