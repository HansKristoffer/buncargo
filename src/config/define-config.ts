import type {
	AppConfig,
	ComputedPorts,
	ComputedUrls,
	DevConfigInput,
	EnvValues,
	EnvVarsContext,
	ServiceConfig,
	TypedAppDefinitions,
} from "../types";

type AppsNever = Record<string, never>;

/**
 * Infer `TApps` from the `apps` object and `TEnv` from the `env` callback
 * return. Everything else that consumes app keys (`env` parameters, `hooks`,
 * `seed`, `options`) is `NoInfer`, so those get contextual typing after
 * inference and cannot drag `TApps` back to `Record<string, never>` — that is
 * what broke factory wrappers such as `createLulluDevConfig()`.
 */
type DefineDevConfigArg<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues,
> = Omit<
	DevConfigInput<TServices, TApps, TEnv>,
	"apps" | "env" | "hooks" | "seed" | "options"
> & {
	// Required, not optional: an optional `apps` stops being an inference site
	// once the parameter is buried in this intersection, and `TApps` silently
	// falls back to its constraint. The no-apps overload covers that case.
	apps: TApps & NoInfer<TypedAppDefinitions<TServices, TApps>>;
	env?: (
		ports: NoInfer<ComputedPorts<TServices, TApps>>,
		urls: NoInfer<ComputedUrls<TServices, TApps>>,
		ctx: NoInfer<EnvVarsContext<TServices, TApps>>,
	) => TEnv;
	hooks?: NoInfer<DevConfigInput<TServices, TApps, TEnv>["hooks"]>;
	seed?: NoInfer<DevConfigInput<TServices, TApps, TEnv>["seed"]>;
	options?: NoInfer<DevConfigInput<TServices, TApps, TEnv>["options"]>;
};

/**
 * Define a typed dev config.
 *
 * `apps` is the inference source for app keys (`requiredApps`, `publicUrls`,
 * `envVars`). `env`'s return is the inference source for overlay keys
 * (`getEnvVar(config, "VITE_PORT")`). Configs with no `apps` need the dedicated
 * overload, since `apps` has to be a required property to be inferred at all.
 *
 * Never pass explicit type arguments. Every parameter is inferred, and none has
 * a default, so a partial list like
 * `defineDevConfig<typeof services, typeof apps>(...)` is a compile error
 * instead of quietly binding `typeof apps` to `TEnv` and erasing every overlay
 * key from `getEnvVar`. To name the resulting type, use
 * `ReturnType<typeof createMyDevConfig>` rather than re-supplying arguments.
 */
export function defineDevConfig<
	const TServices extends Record<string, ServiceConfig>,
	const TEnv extends EnvValues,
>(
	config: Omit<DevConfigInput<TServices, AppsNever, TEnv>, "env"> & {
		apps?: undefined;
		env?: (
			ports: NoInfer<ComputedPorts<TServices, AppsNever>>,
			urls: NoInfer<ComputedUrls<TServices, AppsNever>>,
			ctx: NoInfer<EnvVarsContext<TServices, AppsNever>>,
		) => TEnv;
	},
): DevConfigInput<TServices, AppsNever, TEnv>;
export function defineDevConfig<
	const TServices extends Record<string, ServiceConfig>,
	const TApps extends Record<string, AppConfig>,
	const TEnv extends EnvValues,
>(
	config: DefineDevConfigArg<TServices, TApps, TEnv>,
): DevConfigInput<TServices, TApps, TEnv>;
export function defineDevConfig(config: object): object {
	// Deliberately untyped: no single signature is compatible with both
	// overloads, because `apps` and the callbacks that read its keys make the
	// two instantiations mutually unassignable.
	return config;
}
