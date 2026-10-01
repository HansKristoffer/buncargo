import type { IntegrationAppNames } from "./all-types";
import type { AppConfig, SecretsScopeConfig, TypedAppDefinitions } from "./app";
import type {
	GeneratedFileConfig,
	ProfileConfig,
	SetupCheck,
	TaskConfig,
} from "./commands";
import type {
	ComputedLoopbackUrls,
	ComputedPorts,
	ComputedPublicUrls,
	ComputedUrls,
} from "./computed";
import type { DevEnvironment, DevEnvironmentFor } from "./environment";
import type { DevHooks } from "./hooks";
import type { BuncargoIntegration } from "./integrations";
import type { MigrationConfig, PrismaConfig, SeedConfig } from "./preparation";
import type { DockerComposeGenerationOptions, ServiceConfig } from "./service";
import type { ConcreteStringKeys } from "./type-utils";

// ═══════════════════════════════════════════════════════════════════════════
// Dev Config
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for the dev environment.
 *
 * App/service keys are checked against the config's own keys. The defaults keep
 * the standalone type usable for configs loaded at runtime, where keys are only
 * known as `string` and {@link validateConfig} does the checking instead.
 */
export interface DevOptions<
	TServices extends Record<string, ServiceConfig> = Record<
		string,
		ServiceConfig
	>,
	TApps extends Record<string, AppConfig> = Record<string, AppConfig>,
> {
	/**
	 * Enable worktree isolation. When true (default), each worktree gets:
	 * - unique ports (offset)
	 * - unique Docker Compose project name (separate containers/networks/volumes)
	 *
	 * Set to false to intentionally share Docker state across worktrees.
	 */
	worktreeIsolation?: boolean;
	/**
	 * Auto-shutdown after idle time in ms. Set to false to disable.
	 * Default: 180000 (3 minutes). Applies to `buncargo dev`; a library
	 * `start()` keeps its containers after the process exits unless the script
	 * asks for a hold with `claimRun({ idleTimeoutMs })`.
	 *
	 * Also how long containers are held after a clean exit, so raise it if you
	 * routinely stop and restart `dev` with a longer gap than this.
	 */
	autoShutdown?: number | false;
	/** Default verbose setting for all operations. Default: true */
	verbose?: boolean;
	/**
	 * The app this project is "about": the one a menu bar Open button, the bare
	 * named hostname and any other "just show me the app" surface should pick.
	 *
	 * Defaults to `hosts.primaryApp`, then `frontendApp`, then the app no other
	 * selected app depends on. Set it once here rather than per consumer.
	 */
	primaryApp?: Extract<keyof TApps, string>;
	/** App key used by getExpoApiUrl(). Default: 'api' */
	expoApiApp?: Extract<keyof TApps, string>;
	/** App key used by getFrontendPort(). Default: 'platform', then 'web' */
	frontendApp?: Extract<keyof TApps, string>;
	/**
	 * Named `.localhost` HTTPS URLs via the shared loopback proxy.
	 * `true` uses defaults. Off on Windows, in CI, or when `BUNCARGO_HOSTS=0`
	 * or `BUCARGO_SKIP_MKCERT=true`.
	 */
	hosts?: boolean | HostsOptions<TServices, TApps>;
	/**
	 * Keep a dotenv on disk in step with the allocated ports, for tooling that
	 * reads `.env` instead of inheriting buncargo's environment.
	 * `true` uses `.env`. Off by default.
	 */
	envFile?: boolean | EnvFileOptions;
	/** Root-relative dotenv defaults, loaded after config evaluation; later files win. */
	envFiles?: readonly EnvInputFile[];
}

/**
 * Options for {@link DevOptions.envFile}.
 */
export interface EnvFileOptions {
	/** Dotenv to sync, relative to the repo root. Default: `.env` */
	path?: string;
	/** Template copied in when `path` does not exist yet, e.g. `.env.example`. */
	createFrom?: string;
	/**
	 * Extra keys to sync, merged over the computed ones.
	 *
	 * For a name buncargo cannot derive — a second connection string for the same
	 * database, a URL with a path suffix. Only `loopbackUrls` is offered, not
	 * `urls`: a named `https://` host in a dotenv breaks exactly the tooling this
	 * file exists for. As everywhere else, a key absent from the file is not
	 * added and a value that is not buncargo's to own is not touched.
	 */
	values?: (
		ports: Readonly<Record<string, number>>,
		loopbackUrls: Readonly<Record<string, string>>,
	) => Record<string, string | number | undefined>;
}

/**
 * Options for named local HTTPS URLs.
 */
export interface HostsOptions<
	TServices extends Record<string, ServiceConfig> = Record<
		string,
		ServiceConfig
	>,
	TApps extends Record<string, AppConfig> = Record<string, AppConfig>,
> {
	/** DNS suffix. Default: `localhost`. Multi-label values like `dev.example.com` are allowed. */
	tld?: string;
	/** App key whose hostname omits the app label (`web` → `serpier.localhost`). */
	primaryApp?: Extract<keyof TApps, string>;
	/**
	 * HTTP Docker UIs to name. Default: `mailpit` and `typesense`.
	 * `true` names every HTTP-capable service.
	 */
	services?: readonly Extract<keyof TServices, string>[] | true;
}

/**
 * {@link HostsOptions} with its keys widened to `string`.
 *
 * Runtime consumers take this: a `HostsOptions<TServices, TApps>` from a typed
 * config is assignable to it, while a generic `HostsOptions<…>` is not
 * assignable to another instantiation of itself.
 */
export type HostsOptionsLike = {
	tld?: string;
	primaryApp?: string;
	services?: readonly string[] | true;
};

/**
 * One named hostname mapped to a local listen port.
 */
export interface NamedHost {
	kind: "app" | "service";
	name: string;
	hostname: string;
	/**
	 * The same hostname without the worktree label, so every checkout of a
	 * project agrees on one name.
	 *
	 * Equal to `hostname` outside a worktree. Certificate coverage is derived
	 * from this rather than from `hostname`: a wildcard built per worktree
	 * would be a new name on every checkout, which is the remint this exists
	 * to avoid.
	 */
	baseHostname: string;
	targetPort: number;
}

/**
 * Runtime named-hosts state on a {@link DevEnvironment}.
 */
export interface HostsRuntime {
	plan: NamedHost[];
	active: boolean;
	tld: string;
	caPath?: string;
}

/**
 * Env values a config may declare or compute.
 *
 * `undefined` is allowed so `process.env.X` and optional public URLs can be
 * passed straight through; those entries are dropped when the environment is
 * built rather than stringified into the literal `"undefined"`.
 */
export type EnvInputFile = string | { path: string; optional?: boolean };

export type EnvValues = Record<string, string | number | undefined>;

/**
 * Third argument to {@link EnvVarsBuilder}: identity, LAN IP, and public URLs.
 */
export type EnvVarsContext<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> = {
	projectName: string;
	localIp: string;
	portOffset: number;
	/** Root dotenv defaults overlaid by inherited environment, resolved after config evaluation. */
	env?: Readonly<Record<string, string>>;
	workspaceId?: string;
	publicUrls: ComputedPublicUrls<TServices, TApps>;
	/** `http://localhost:<port>` URLs, never rewritten by named hosts */
	loopbackUrls: ComputedLoopbackUrls<TServices, TApps>;
	/** Values apps printed, by capture name (see `AppConfig.captures`). */
	captured?: Readonly<Record<string, string>>;
};

/**
 * Environment variable builder function.
 *
 * `TEnv` is the overlay object the callback returns. Leave it at the
 * {@link EnvValues} default for an open record; a narrowly inferred return
 * (the usual `defineDevConfig({ env: () => ({ VITE_PORT }) })` case) is what
 * {@link OverlayEnvVarNames} and `getEnvVar` read as extra keys.
 */
export type EnvVarsBuilder<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues = EnvValues,
> = (
	ports: ComputedPorts<TServices, TApps>,
	urls: ComputedUrls<TServices, TApps>,
	ctx: EnvVarsContext<TServices, TApps>,
) => TEnv;

/**
 * Object keys that are not a wide `string` index (`Record<string, …>`).
 * Used so empty-app configs and open records do not unlock every `*_URL`.
 */

/**
 * Keys declared by a narrowly inferred `env` overlay.
 *
 * A wide {@link EnvValues} (`Record<string, …>`) contributes nothing: otherwise
 * every string would become a legal `getEnvVar` name.
 */
export type OverlayEnvVarNames<TEnv> = ConcreteStringKeys<TEnv>;

/**
 * Main configuration for the dev environment.
 */
export interface DevConfig<
	TServices extends Record<string, ServiceConfig> = Record<
		string,
		ServiceConfig
	>,
	TApps extends Record<string, AppConfig> = Record<string, AppConfig>,
	TEnv extends EnvValues = EnvValues,
> {
	/** Prefix for Docker project name (e.g., 'myapp' -> 'myapp-main') */
	projectPrefix: string;
	/** Docker Compose services to manage */
	services: TServices;
	/** Applications to start (optional) */
	apps?: TApps;
	/**
	 * Shared env overlay merged on top of computed ports/urls for every process.
	 * Use this for values that belong to the whole stack (rewritten WEB_URL,
	 * VITE_* aliases, SMTP_HOST). App-only values stay on `apps.<name>.envVars`.
	 */
	env?: EnvVarsBuilder<TServices, TApps, TEnv>;
	/** Lifecycle hooks (optional) */
	hooks?: DevHooks<TServices, TApps>;
	/** Migrations to run after containers are ready (optional). Runs sequentially. */
	migrations?: MigrationConfig[];
	/** Seed configuration (optional). Runs after migrations, before servers. */
	seed?: SeedConfig<TServices, TApps>;
	/** Prisma configuration (optional). When set, dev.prisma is available. */
	prisma?: PrismaConfig<TServices, TApps>;
	/** Additional options (optional) */
	options?: DevOptions<TServices, TApps>;
	/** Scope defaults. Set false to disable all buncargo secret fetching for this environment. */
	secrets?: SecretsScopeConfig | false;
	/** Docker Compose generation options (optional) */
	docker?: DockerComposeGenerationOptions;
	/** Preconditions `buncargo dev` verifies before starting (optional) */
	checks?: readonly SetupCheck[];
	/** Files rendered from the run's ports, URLs and captures (optional) */
	generatedFiles?: readonly GeneratedFileConfig[];
	/**
	 * Integrations (`buncargo/shopify`, `buncargo/expo`, …), applied in order
	 * before the config is validated (optional).
	 */
	integrations?: readonly BuncargoIntegration[];
	/** Named scripts for `buncargo run <name>` (optional) */
	tasks?: Record<
		string,
		TaskConfig<Extract<keyof TServices, string>, Extract<keyof TApps, string>>
	>;
	/**
	 * Named app selections for `buncargo dev --profile=<name>` (optional).
	 * A profile named `default` is what a bare `buncargo dev` runs.
	 */
	profiles?: Record<
		string,
		ProfileConfig<
			Extract<keyof TApps, string> | Extract<keyof IntegrationAppNames, string>
		>
	>;
}

/**
 * A {@link DevConfig} whose app definitions are constrained to the config's own
 * service and app keys. This is what {@link DevConfig} looks like once written
 * in a `dev.config.ts`, and the exact type `defineDevConfig` accepts and returns.
 */
export type DevConfigInput<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues = EnvValues,
> = DevConfig<TServices, TypedAppDefinitions<TServices, TApps>, TEnv>;

/**
 * {@link DevOptions} with its app/service key positions widened to `string`.
 *
 * `keyof T` inverts variance, so `DevOptions<{ api: … }>` is not assignable to
 * `DevOptions<Record<string, …>>`. Widening the keys is what restores it.
 */
type AnyDevOptions = Omit<
	DevOptions,
	"primaryApp" | "expoApiApp" | "frontendApp" | "hosts"
> & {
	primaryApp?: string;
	expoApiApp?: string;
	frontendApp?: string;
	hosts?: boolean | HostsOptionsLike;
};

/** {@link PrismaConfig} with its service/env-name positions widened to `string`. */
type AnyPrismaConfig = Omit<PrismaConfig, "service" | "urlEnvVar"> & {
	service?: string;
	urlEnvVar?: string;
};

/** {@link DevHooks} with the hook names kept but their context erased. */
type AnyDevHooks = {
	[K in keyof DevHooks<
		Record<string, ServiceConfig>,
		Record<string, AppConfig>
	>]?: (...args: never[]) => void | Promise<void>;
};

/** {@link SeedConfig} with `check`'s context erased. */
type AnyDevSeedConfig = Omit<
	SeedConfig<Record<string, ServiceConfig>, Record<string, AppConfig>>,
	"check"
> & {
	check?: (...args: never[]) => Promise<boolean>;
};

/**
 * Any dev config, with service/app keys unknown.
 *
 * Use this where a config is loaded at runtime and its shape cannot be known
 * statically. Prefer a concrete `typeof myConfig` wherever it is available.
 *
 * `env`, `hooks` and `seed.check` receive the config's *own* computed ports and
 * urls, so they are declared here with placeholder `never[]` parameters. That is
 * what makes every concrete config assignable to this type, and it is why this
 * is a read-only view: reading `config.seed?.command` is fine, calling
 * `config.env(...)` through it is not.
 */
export type AnyDevConfig = Omit<
	DevConfig,
	"env" | "hooks" | "seed" | "options" | "prisma"
> & {
	env?: (...args: never[]) => EnvValues;
	hooks?: AnyDevHooks;
	seed?: AnyDevSeedConfig;
	options?: AnyDevOptions;
	prisma?: AnyPrismaConfig;
};

/**
 * Constraint for generics that accept "some concrete config type".
 *
 * {@link AnyDevConfig} cannot serve as that bound: `env`, `hooks` and `seed`
 * receive the config's *own* computed ports and urls, so a concrete config is
 * not assignable to the widened one. This shape only pins down the parts that
 * are invariant across configs.
 */
export type DevConfigLike = {
	projectPrefix: string;
	services: Record<string, ServiceConfig>;
	apps?: Record<string, AppConfig>;
	/**
	 * Declared so {@link DevEnvironmentFor} can recover the overlay type. The
	 * parameters are `never[]` because any concrete builder must stay assignable
	 * to this shape, and function parameters are contravariant.
	 */
	env?: (...args: never[]) => EnvValues;
};
