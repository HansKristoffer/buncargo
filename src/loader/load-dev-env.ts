import { assertValidConfig } from "../config";
import { createDevEnvironment } from "../environment";
import type {
	AnyDevConfig,
	AnyDevEnvironment,
	AppConfig,
	DevConfig,
	DevConfigLike,
	DevEnvironmentFor,
	ServiceConfig,
} from "../types";
import {
	getCachedDevEnv,
	getCachedRuntimeSelection,
	setCachedDevEnv,
} from "./cache";
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
	/** `--runtime`, taking precedence over env and config. */
	containerRuntime?: string;
}): Promise<DevEnvironmentFor<TConfig>> {
	const requested = options?.containerRuntime;

	if (!options?.reload) {
		const cached = getCachedDevEnv();
		// A cached env is bound to the runtime it was built with, so an explicit
		// request for a different one has to rebuild rather than be ignored. Both
		// sides of this are selections, so `--runtime=auto` can hit the cache.
		if (
			cached &&
			(requested === undefined || requested === getCachedRuntimeSelection())
		) {
			return cached as DevEnvironmentFor<TConfig>;
		}
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
	//
	// `AnyDevConfig` is deliberately not the cast target: its callbacks carry
	// placeholder signatures so every concrete config stays assignable to it,
	// which also means it cannot be handed to something that calls them.
	const env = createDevEnvironment(
		loaded as DevConfig<
			Record<string, ServiceConfig>,
			Record<string, AppConfig>
		>,
		{ containerRuntime: requested },
	);
	setCachedDevEnv(env, requested);
	return env as DevEnvironmentFor<TConfig>;
}
