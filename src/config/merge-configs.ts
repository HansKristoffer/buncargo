import type {
	AppConfig,
	DevConfig,
	EnvValues,
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
	TEnvBase extends EnvValues,
	TEnvOverride extends EnvValues,
>(
	base: EnvVarsBuilder<TServices, TApps, TEnvBase> | undefined,
	override: EnvVarsBuilder<TServices, TApps, TEnvOverride> | undefined,
): EnvVarsBuilder<TServices, TApps, TEnvBase & TEnvOverride> | undefined {
	if (!base) {
		return override as
			| EnvVarsBuilder<TServices, TApps, TEnvBase & TEnvOverride>
			| undefined;
	}
	if (!override) {
		return base as EnvVarsBuilder<TServices, TApps, TEnvBase & TEnvOverride>;
	}
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

/**
 * Merge an override config over a base one.
 *
 * The result's overlay type is the intersection of both, because
 * `mergeEnvBuilders` runs both builders rather than replacing one.
 */
export function mergeConfigs<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnvBase extends EnvValues = EnvValues,
	TEnvOverride extends EnvValues = EnvValues,
>(
	base: DevConfig<TServices, TApps, TEnvBase>,
	overrides: Partial<DevConfig<TServices, TApps, TEnvOverride>>,
): DevConfig<TServices, TApps, TEnvBase & TEnvOverride> {
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
