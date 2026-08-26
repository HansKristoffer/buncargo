import { assertValidConfig } from "../config";
import { createDevEnvironment } from "../environment";
import type {
	AnyDevConfig,
	AnyDevEnvironment,
	DevConfigLike,
	DevEnvironmentFor,
} from "../types";
import { getCachedDevEnv, setCachedDevEnv } from "./cache";
import { findConfigFile } from "./find-config-file";

/**
 * Load `dev.config.ts` from disk and build its dev environment.
 *
 * The config is imported at runtime, so its shape cannot be inferred. Pass the
 * config type to keep `defineDevConfig` inference (`ports`, `urls`,
 * `getEnvVar`) for programmatic consumers:
 *
 * ```ts
 * import type devConfig from "./dev.config";
 * const env = await loadDevEnv<typeof devConfig>();
 * ```
 *
 * Callers that do not know the config statically (the CLI) can omit it and get
 * the widened {@link AnyDevEnvironment} shape.
 */
export async function loadDevEnv<
	TConfig extends DevConfigLike = AnyDevConfig,
>(options?: {
	cwd?: string;
	reload?: boolean;
}): Promise<DevEnvironmentFor<TConfig>> {
	if (!options?.reload) {
		const cached = getCachedDevEnv();
		if (cached) return cached as DevEnvironmentFor<TConfig>;
	}

	const cwd = options?.cwd ?? process.cwd();
	const configPath = findConfigFile(cwd);

	if (!configPath) {
		throw new Error(
			"No config file found. Create dev.config.ts with: export default defineDevConfig({ ... })",
		);
	}

	const mod = await import(configPath);
	if (!("default" in mod) || mod.default === undefined) {
		throw new Error(
			`Invalid config in "${configPath}". Use defineDevConfig() and export as default.`,
		);
	}

	const loaded: unknown = mod.default;
	assertValidConfig(loaded);

	// The dynamic import is untyped, so the caller's TConfig is the only source
	// of shape information. This cast is the single trust boundary for it.
	const env = createDevEnvironment(loaded as AnyDevConfig);
	setCachedDevEnv(env);
	return env as DevEnvironmentFor<TConfig>;
}
