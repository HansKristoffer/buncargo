import type { AppConfig, DeclaredAppEnvVars, DeclaredStaticEnv } from "./app";
import type { EnvValues, OverlayEnvVarNames } from "./config";
import type { BuiltInServiceEnvVarMap, ServiceConfig } from "./service";
import type { ConcreteStringKeys } from "./type-utils";

// ═══════════════════════════════════════════════════════════════════════════
// Computed Types (Type-Level Utilities)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Computed ports object - maps service/app names to their port numbers.
 */
// Helper to extract services that have secondaryPort defined
type ServicesWithSecondaryPort<
	TServices extends Record<string, ServiceConfig>,
> = {
	[K in keyof TServices as TServices[K] extends { secondaryPort: number }
		? `${K & string}Secondary`
		: never]: number;
};

/** Keep endpoint members only when a service declares a host port. */
type WithServicePort<TService, TValue> = "port" extends keyof TService
	? TService["port"] extends undefined
		? never
		: TValue
	: never;

/** Keep unresolved app keys during inference; exclude resolved workers. */
type ForServerApp<TApp, TValue> = [TApp] extends [never]
	? TValue
	: [TApp] extends [{ kind: "worker" }]
		? never
		: TValue;

/**
 * Ports for every service and app.
 *
 * The app mapping is deliberately not filtered through
 * {@link ConcreteStringKeys}: while `TApps` is still being inferred, the
 * `envVars` callbacks inside `apps` see it as its `Record<string, AppConfig>`
 * constraint, and dropping an open record there would leave those callbacks
 * with no `ports.<app>` at all.
 */
export type ComputedPorts<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> = {
	[K in keyof TServices as WithServicePort<TServices[K], K>]: number;
} & {
	[K in keyof TApps as ForServerApp<TApps[K], K>]: number;
} & ServicesWithSecondaryPort<TServices>;

/**
 * URLs for every service and app, plus a `<app>Local` LAN URL per app.
 */
export type ComputedUrls<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> = {
	[K in keyof TServices as WithServicePort<TServices[K], K>]: string;
} & {
	[K in keyof TApps as ForServerApp<TApps[K], K>]: string;
} & {
	[K in keyof TApps as ForServerApp<TApps[K], `${K & string}Local`>]: string;
};

/**
 * Loopback URLs for every service and app, unaffected by named hosts.
 *
 * When `options.hosts` is active, {@link ComputedUrls} entries are rewritten to
 * `https://<name>.<project>.localhost`, which only a client that trusts the
 * local CA can reach. Playwright, the Stripe CLI and GUI database clients
 * cannot, so they need the `http://localhost:<port>` form that these preserve.
 *
 * There is deliberately no `<app>Local` member: that key is the LAN IP, which
 * is a different address for a different purpose.
 */
export type ComputedLoopbackUrls<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> = {
	[K in keyof TServices as WithServicePort<TServices[K], K>]: string;
} & {
	[K in keyof TApps as ForServerApp<TApps[K], K>]: string;
};

/**
 * Whether a service/app config opted into public tunnels.
 *
 * Resolved config literals narrow exactly: `expose: true` matches, `expose:
 * false` and an omitted `expose` do not. An unresolved `ServiceConfig`/
 * `AppConfig` (whose `expose` is still the declared `boolean | undefined`)
 * matches permissively, because TypeScript cannot see literal types while it is
 * still inferring the object they came from.
 */
type IsExposed<T> = "expose" extends keyof T
	? true extends T["expose"]
		? true
		: false
	: false;

/**
 * Keys of services and apps that opted into public tunnels with `expose: true`.
 *
 * Only these can ever receive a `*.trycloudflare.com` URL, so the public-URL
 * surface is derived from this rather than from every configured key.
 */
export type ExposedKeys<TServices extends object, TApps extends object> =
	| {
			[K in keyof TServices]: IsExposed<TServices[K]> extends true ? K : never;
	  }[keyof TServices]
	| {
			[K in keyof TApps]: IsExposed<TApps[K]> extends true ? K : never;
	  }[keyof TApps];

/**
 * Public tunnel URLs, keyed by the exposed services/apps.
 *
 * Values are optional because tunnels only exist while `--expose` is active.
 */
export type ComputedPublicUrls<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> = Partial<{
	[K in ExposedKeys<TServices, TApps>]: string;
}>;

type ExplicitServiceEnvVarNames<TService extends ServiceConfig> =
	TService extends ServiceConfig
		? ConcreteStringKeys<NonNullable<TService["env"]>>
		: never;

type ServiceEnvVarNamesFromKey<TKey extends string> =
	TKey extends keyof BuiltInServiceEnvVarMap
		? Extract<keyof BuiltInServiceEnvVarMap[TKey], string>
		: never;

type ServiceEnvVarNamesFromPreset<TService extends ServiceConfig> =
	TService["docker"] extends {
		kind: "preset";
		preset: infer TPreset;
	}
		? TPreset extends keyof BuiltInServiceEnvVarMap
			? Extract<keyof BuiltInServiceEnvVarMap[TPreset], string>
			: never
		: never;

export type ServiceEnvVarNames<
	TServices extends Record<string, ServiceConfig>,
> = {
	[K in keyof TServices]:
		| ExplicitServiceEnvVarNames<TServices[K]>
		| WithServicePort<
				TServices[K],
				| ServiceEnvVarNamesFromKey<Extract<K, string>>
				| ServiceEnvVarNamesFromPreset<TServices[K]>
		  >
		| OverlayEnvVarNames<DeclaredStaticEnv<TServices[K]>>;
}[keyof TServices];

export type SharedEnvVarNames<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> =
	| "COMPOSE_PROJECT_NAME"
	| "NODE_ENV"
	| "NODE_EXTRA_CA_CERTS"
	| "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS"
	| `${Uppercase<Extract<keyof ComputedPorts<TServices, TApps>, string>>}_PORT`
	| `${Uppercase<Extract<keyof ComputedUrls<TServices, TApps>, string>>}_URL`
	| `${Uppercase<
			Extract<keyof ComputedLoopbackUrls<TServices, TApps>, string>
	  >}_LOOPBACK_URL`
	| `${Uppercase<Extract<ExposedKeys<TServices, TApps>, string>>}_PUBLIC_URL`;

export type ConfigEnvVarNames<
	TServices extends Record<string, ServiceConfig>,
	TApps extends object,
	TEnv = EnvValues,
> =
	| SharedEnvVarNames<
			TServices,
			[TApps] extends [Record<string, AppConfig>]
				? TApps
				: Record<string, never>
	  >
	| ServiceEnvVarNames<TServices>
	| OverlayEnvVarNames<TEnv>;

/**
 * Value `getEnvVar` returns for `name`. Overlay keys keep the type the `env`
 * callback declared; computed / service names stay `string | number`.
 */
export type GetEnvVarValue<
	TEnv,
	TName extends string,
> = TName extends keyof TEnv ? TEnv[TName] : string | number | undefined;

/**
 * Env names that only exist while named hosts are active, so they cannot be
 * guaranteed present in a built environment.
 */
export type HostOnlyEnvVarNames =
	| "NODE_EXTRA_CA_CERTS"
	| "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS";

/**
 * A built shared environment.
 *
 * Every computed name is present, plus whatever `config.env` declared. Names
 * that only appear under named hosts are optional. There is deliberately no
 * open index signature: an unknown name is a typo, not a lookup.
 */
export type ComputedEnvVars<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv = EnvValues,
> = Record<
	Exclude<ConfigEnvVarNames<TServices, TApps, TEnv>, HostOnlyEnvVarNames>,
	string
> &
	Partial<Record<HostOnlyEnvVarNames | "BUNCARGO_WORKSPACE_ID", string>>;

/**
 * Env names the spawner injects into an app process only while named hosts are
 * active, so they cannot be guaranteed present.
 */
export type AppHostOnlyEnvVarNames =
	| "BUNCARGO_APP_HOSTNAME"
	| "BUNCARGO_HOSTS_PORT";

/**
 * The environment one app's own process receives: the shared surface plus that
 * app's `staticEnv` and `envVars` keys, plus the `PORT`/`HOST`/`BUNCARGO_APP_NAME`
 * trio the spawner always injects.
 */
export type AppEnvVars<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues,
	TName extends keyof TApps,
> = ComputedEnvVars<TServices, TApps, TEnv> &
	Record<
		| OverlayEnvVarNames<DeclaredStaticEnv<TApps[TName]>>
		| OverlayEnvVarNames<DeclaredAppEnvVars<TApps[TName]>>
		| (TApps[TName] extends { kind: "worker" } ? never : "PORT" | "HOST")
		| "BUNCARGO_APP_NAME",
		string
	> &
	Partial<
		Record<AppHostOnlyEnvVarNames | "EXPO_PUBLIC_BUNCARGO_WORKSPACE_ID", string>
	>;
