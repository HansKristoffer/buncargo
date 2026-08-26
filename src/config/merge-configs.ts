import type {
	AppConfig,
	DevConfig,
	EnvVarsBuilder,
	ServiceConfig,
} from "../types";

/**
 * Compose two shared env builders into one: both run, and the override's keys
 * win. Replacing instead of composing would silently drop the base config's
 * whole shared env surface.
 */
function mergeEnvBuilders<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	base: EnvVarsBuilder<TServices, TApps> | undefined,
	override: EnvVarsBuilder<TServices, TApps> | undefined,
): EnvVarsBuilder<TServices, TApps> | undefined {
	if (!base) return override;
	if (!override) return base;
	return (ports, urls, ctx) => ({
		...base(ports, urls, ctx),
		...override(ports, urls, ctx),
	});
}

/** Merge two optional groups, staying `undefined` when neither side sets one. */
function mergeGroup<T extends object>(
	base: T | undefined,
	override: T | undefined,
): T | undefined {
	if (!base) return override;
	if (!override) return base;
	return { ...base, ...override };
}

export function mergeConfigs<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	base: DevConfig<TServices, TApps>,
	overrides: Partial<DevConfig<TServices, TApps>>,
): DevConfig<TServices, TApps> {
	return {
		...base,
		...overrides,
		services: { ...base.services, ...overrides.services },
		apps: mergeGroup(base.apps, overrides.apps),
		env: mergeEnvBuilders(base.env, overrides.env),
		hooks: mergeGroup(base.hooks, overrides.hooks),
		migrations: overrides.migrations ?? base.migrations,
		seed: overrides.seed ?? base.seed,
		options: mergeGroup(base.options, overrides.options),
		docker: mergeGroup(base.docker, overrides.docker),
	};
}
