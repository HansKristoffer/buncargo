import type {
	AnyDevConfig,
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
type SharedEnvBuilder = EnvVarsBuilder<
	Record<string, ServiceConfig>,
	Record<string, AppConfig>
>;
function mergeEnvBuilders(
	base: SharedEnvBuilder | undefined,
	override: SharedEnvBuilder | undefined,
): SharedEnvBuilder | undefined {
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

/** Keys from the override replace the base, matching object spread at runtime. */
type Overlay<TBase, TOverride> = Omit<TBase, keyof TOverride> & TOverride;
// An unspecified overlay contributes no known names; a concrete override still does.
type KnownEnv<T> = string extends keyof T ? Record<never, never> : T;
type BaseApps<T extends AnyDevConfig> = NonNullable<T["apps"]>;
type BaseEnv<T extends AnyDevConfig> = NonNullable<T["env"]> extends (
	...args: never[]
) => infer R
	? Extract<R, EnvValues>
	: Record<never, never>;

/** Merge reusable configs without losing added app, service or environment keys. */
export function mergeConfigs<
	TBase extends AnyDevConfig,
	const TServices extends Record<string, ServiceConfig> = Record<never, never>,
	const TApps extends Record<string, AppConfig> = Record<never, never>,
	TEnv extends EnvValues = Record<never, never>,
>(
	base: TBase,
	overrides: Omit<
		Partial<
			DevConfig<
				Overlay<TBase["services"], TServices>,
				Overlay<BaseApps<TBase>, TApps>,
				TEnv
			>
		>,
		"services" | "apps"
	> & { services?: TServices; apps?: TApps },
): DevConfig<
	Overlay<TBase["services"], TServices>,
	Overlay<BaseApps<TBase>, TApps>,
	Overlay<KnownEnv<BaseEnv<TBase>>, TEnv>
>;
/** Compatibility overload for callers that supply the original generic parameters. */
export function mergeConfigs<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnvBase extends EnvValues = EnvValues,
	TEnvOverride extends EnvValues = EnvValues,
>(
	base: DevConfig<TServices, TApps, TEnvBase>,
	overrides: Partial<DevConfig<TServices, TApps, TEnvOverride>>,
): DevConfig<TServices, TApps, Overlay<TEnvBase, TEnvOverride>>;
export function mergeConfigs(
	base: AnyDevConfig,
	overrides: Partial<AnyDevConfig>,
): AnyDevConfig {
	return {
		...base,
		...overrides,
		services: { ...base.services, ...overrides.services },
		apps: mergeGroup(base.apps, overrides.apps),
		env: mergeEnvBuilders(
			base.env as SharedEnvBuilder | undefined,
			overrides.env as SharedEnvBuilder | undefined,
		),
		hooks: mergeGroup(base.hooks, overrides.hooks),
		migrations: overrides.migrations ?? base.migrations,
		seed: overrides.seed ?? base.seed,
		options: mergeGroup(base.options, overrides.options),
		docker: mergeGroup(base.docker, overrides.docker),
		secrets:
			base.secrets === false || overrides.secrets === false
				? (overrides.secrets ?? base.secrets)
				: mergeGroup(base.secrets, overrides.secrets),
		tasks: mergeGroup(base.tasks, overrides.tasks),
		profiles: mergeGroup(base.profiles, overrides.profiles),
	};
}
