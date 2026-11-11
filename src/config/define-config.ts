import type {
	AppConfig,
	BuncargoIntegration,
	ComputedPorts,
	ComputedUrls,
	DevConfigInput,
	EnvValues,
	EnvVarsContext,
	IntegrationAdds,
	IntegrationAppKeys,
	IntegrationServiceKeys,
	ProfileConfig,
	ServiceConfig,
	TaskConfig,
	TypedAppDefinitions,
} from "../types";

type AnyIntegrations = readonly BuncargoIntegration<IntegrationAdds>[];

/**
 * Infer `TApps` from the `apps` object, `TEnv` from the `env` callback return
 * and `TIntegrations` from the `integrations` tuple. Everything else that
 * consumes app keys (`env` parameters, `hooks`, `seed`, `options`) is
 * `NoInfer`, so those get contextual typing after inference and cannot drag
 * `TApps` back to its default. That drag is what broke factory wrappers such
 * as `createLulluDevConfig()`.
 *
 * The positions that only name keys (`requiredServices`, `requiredApps`,
 * `startAfter`, `tasks`, `profiles`) also accept the keys the integrations add.
 */
type DefineDevConfigArg<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues,
	TIntegrations extends AnyIntegrations,
	TServiceKey extends string = Extract<keyof TServices, string>,
	TAppKey extends string = Extract<keyof TApps, string>,
	TAddedServices extends string = IntegrationServiceKeys<TIntegrations>,
	TAddedApps extends string = IntegrationAppKeys<TIntegrations>,
> = Omit<
	DevConfigInput<TServices, TApps, TEnv>,
	| "apps"
	| "env"
	| "hooks"
	| "seed"
	| "options"
	| "tasks"
	| "profiles"
	| "integrations"
> & {
	// The mapped type over `keyof TApps` is what keeps an optional `apps` an
	// inference site: a plain `TApps & NoInfer<…>` loses it as soon as an app
	// has an `envVars` callback, and `TApps` falls back to its default.
	apps?: TApps & {
		[K in keyof TApps]: NoInfer<
			TypedAppDefinitions<TServices, TApps, TAddedServices, TAddedApps>
		>[K];
	};
	env?: (
		ports: NoInfer<ComputedPorts<TServices, TApps>>,
		urls: NoInfer<ComputedUrls<TServices, TApps>>,
		ctx: NoInfer<EnvVarsContext<TServices, TApps>>,
	) => TEnv;
	integrations?: TIntegrations;
	hooks?: NoInfer<DevConfigInput<TServices, TApps, TEnv>["hooks"]>;
	seed?: NoInfer<DevConfigInput<TServices, TApps, TEnv>["seed"]>;
	options?: NoInfer<DevConfigInput<TServices, TApps, TEnv>["options"]>;
	tasks?: NoInfer<
		Record<
			string,
			TaskConfig<TServiceKey | TAddedServices, TAppKey | TAddedApps>
		>
	>;
	profiles?: NoInfer<Record<string, ProfileConfig<TAppKey | TAddedApps>>>;
};

/**
 * Define a typed dev config.
 *
 * `apps` is the inference source for app keys (`requiredApps`, `publicUrls`,
 * `envVars`). `env`'s return is the inference source for overlay keys
 * (`getEnvVar(config, "VITE_PORT")`). `integrations` is the source for the
 * app and service keys integrations add.
 *
 * Never pass explicit type arguments. Every parameter is inferred, and
 * `TServices`, `TEnv` and `TIntegrations` have no default, so a partial list
 * like `defineDevConfig<typeof services, typeof apps>(...)` is a compile error
 * instead of quietly binding `typeof apps` to the wrong parameter. To name the
 * resulting type, use `ReturnType<typeof createMyDevConfig>` rather than
 * re-supplying arguments.
 */
export function defineDevConfig<
	const TServices extends Record<string, ServiceConfig>,
	const TEnv extends EnvValues,
	const TIntegrations extends AnyIntegrations,
	const TApps extends Record<string, AppConfig> = Record<never, never>,
>(
	config: DefineDevConfigArg<TServices, TApps, TEnv, TIntegrations>,
): DevConfigInput<TServices, TApps, TEnv> {
	// The integrations' names are checked here and not carried into the
	// result: the config's own app and service keys are what its type keeps.
	return config as DevConfigInput<TServices, TApps, TEnv>;
}
