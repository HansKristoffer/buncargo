// ═══════════════════════════════════════════════════════════════════════════
// Service Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Health check function signature for custom health checks.
 */
export type HealthCheckFn = (port: number) => Promise<boolean>;

/**
 * Built-in health check types that map to common patterns.
 */
export type BuiltInHealthCheck = "pg_isready" | "redis-cli" | "http" | "tcp";

/**
 * URL builder context passed to urlTemplate function.
 */
export interface UrlBuilderContext {
	port: number;
	secondaryPort?: number;
	host: string;
	localIp: string;
}

/**
 * URL builder function receives port info and returns the connection URL.
 */
export type UrlBuilderFn = (ctx: UrlBuilderContext) => string;

// ═══════════════════════════════════════════════════════════════════════════
// Docker Compose Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Recursive YAML-safe value used for Docker Compose objects.
 */
export type DockerComposeNode =
	| string
	| number
	| boolean
	| null
	| DockerComposeNode[]
	| { [key: string]: DockerComposeNode | undefined };

/**
 * Supported sources for service-derived environment variables.
 */
export type ServiceEnvValueSource = "url" | "port" | "secondaryPort";

/**
 * Declared env var outputs for a service.
 */
export type ServiceEnvVarMap = Record<string, ServiceEnvValueSource>;

/**
 * Built-in env var aliases exposed by preset services.
 *
 * This is the canonical list of built-in presets: {@link DockerPresetName} is
 * its key set, and both the runtime env map and the compose builder registry
 * are pinned to it with `satisfies`.
 */
export interface BuiltInServiceEnvVarMap {
	postgres: {
		DATABASE_URL: "url";
	};
	redis: {
		REDIS_URL: "url";
	};
	clickhouse: {
		CLICKHOUSE_URL: "url";
		CLICKHOUSE_NATIVE_PORT: "secondaryPort";
	};
	mailpit: {
		MAILPIT_URL: "url";
		SMTP_PORT: "secondaryPort";
	};
	typesense: {
		TYPESENSE_URL: "url";
	};
}

/**
 * Built-in Docker service presets.
 */
export type DockerPresetName = keyof BuiltInServiceEnvVarMap;

/**
 * Docker Compose healthcheck object.
 */
export interface DockerComposeHealthcheckRaw {
	test?: string[] | string;
	interval?: string;
	timeout?: string;
	retries?: number;
	start_period?: string;
	disable?: boolean;
	[composeKey: string]: DockerComposeNode | undefined;
}

/**
 * Docker Compose service (raw escape hatch).
 * Includes common fields plus index signature for advanced keys.
 */
export interface DockerComposeServiceRaw {
	/**
	 * Never set. Present so {@link DockerServiceDefinition} is a discriminated
	 * union: without it the index signature below would give `kind` a type that
	 * overlaps `"preset"`, and `docker.kind === "preset"` would not narrow.
	 */
	kind?: never;
	image?: string;
	container_name?: string;
	ports?: string[];
	volumes?: string[];
	environment?: Record<string, string | number | boolean>;
	command?: string | string[];
	entrypoint?: string | string[];
	depends_on?: string[] | Record<string, DockerComposeNode>;
	healthcheck?: DockerComposeHealthcheckRaw;
	ulimits?: Record<string, number | { soft: number; hard: number }>;
	restart?: string;
	working_dir?: string;
	[composeKey: string]: DockerComposeNode | undefined;
}

/**
 * Docker Compose volume object.
 */
export interface DockerComposeVolumeRaw {
	driver?: string;
	driver_opts?: Record<string, string | number | boolean>;
	[composeKey: string]: DockerComposeNode | undefined;
}

/**
 * Helper-friendly preset service definition.
 */
export interface DockerPresetServiceDefinition {
	kind: "preset";
	preset: DockerPresetName;
	service?: DockerComposeServiceRaw;
}

/**
 * Docker service definition accepted by service config.
 *
 * Discriminated on `kind`: the `service.<preset>()` helpers return `kind:
 * "preset"`, while a raw Compose object (the manual escape hatch) never carries
 * `kind`. Narrow with `docker.kind === "preset"`.
 */
export type DockerServiceDefinition =
	| DockerComposeServiceRaw
	| DockerPresetServiceDefinition;

/**
 * Docker Compose generation configuration.
 */
export interface DockerComposeGenerationOptions {
	/** Path to generated compose file relative to root. Default: '.buncargo/docker-compose.generated.yml' */
	generatedFile?: string;
	/** Write strategy for generated compose file. Default: 'always' */
	writeStrategy?: "always" | "if-missing";
	/** Extra top-level named volumes */
	volumes?: Record<string, DockerComposeVolumeRaw>;
	/** Auto-start Docker if the daemon is down. Default: true (skipped in CI) */
	autoStart?: boolean;
}

/**
 * Configuration for a Docker Compose service (e.g., postgres, redis).
 */
export interface ServiceConfig<
	TEnv extends ServiceEnvVarMap = ServiceEnvVarMap,
	TStatic extends EnvValues = EnvValues,
> {
	/** Base port for the service (before offset is applied) */
	port: number;
	/** Whether this service can be exposed publicly via tunnel */
	expose?: boolean;
	/** Optional secondary port (e.g., ClickHouse native protocol) */
	secondaryPort?: number;
	/** Health check: built-in name, custom function, or disabled (false) */
	healthCheck?: BuiltInHealthCheck | HealthCheckFn | false;
	/** Timeout for service health polling in milliseconds. Default: 30000 */
	healthTimeout?: number;
	/** URL builder function that returns the connection URL */
	urlTemplate?: UrlBuilderFn;
	/** Docker Compose service name (defaults to the key name) */
	serviceName?: string;

	// ─────────────────────────────────────────────────────────────────────────
	// Built-in URL template options (alternative to urlTemplate)
	// When these are set, a built-in URL template is used based on the service name
	// ─────────────────────────────────────────────────────────────────────────

	/** Database name (for postgres, mysql, clickhouse). Enables built-in URL template. */
	database?: string;
	/** Username (default: 'postgres' for postgres, 'root' for mysql, 'default' for clickhouse) */
	user?: string;
	/** Password (default: 'postgres' for postgres, 'root' for mysql, 'clickhouse' for clickhouse) */
	password?: string;
	/** Explicit env vars this service contributes to the shared env surface */
	env?: TEnv;
	/** Constant values merged into the shared env (e.g. SMTP_HOST, API keys) */
	staticEnv?: TStatic;
	/** Docker Compose service definition (preset helper or raw escape hatch) */
	docker?: DockerServiceDefinition;
}

// ═══════════════════════════════════════════════════════════════════════════
// App Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for an application (e.g., api, web).
 */
export interface AppConfig<TStatic extends EnvValues = EnvValues> {
	/** Base port for the app (before offset is applied) */
	port: number;
	/** Whether this app can be exposed publicly via tunnel */
	expose?: boolean;
	/** Command to start the dev server. Set to false to reserve/tunnel the port without starting a process. */
	devCommand: string | false;
	/** Command to start production server (optional) */
	prodCommand?: string;
	/** Command to build for production (optional) */
	buildCommand?: string;
	/** Working directory relative to monorepo root */
	cwd?: string;
	/** Health check endpoint path (e.g., '/api/health'). Set to false to skip readiness wait. */
	healthEndpoint?: string | false;
	/** Timeout for health check in milliseconds */
	healthTimeout?: number;
	/** Service keys that must be running when this app starts */
	requiredServices?: readonly string[];
	/** App keys that must also start when this app starts */
	requiredApps?: readonly string[];
	/** Constant env vars injected only into this app's own processes */
	staticEnv?: TStatic;
	/** Own the TTY (stdin). Only one app may be interactive. */
	interactive?: boolean;
	/** Start this app after public tunnels are open so env sees *_PUBLIC_URL. */
	needsPublicUrls?: boolean;
	/** Computed env vars injected only into this app's own processes */
	envVars?: (...args: never[]) => EnvValues;
}

/**
 * The `staticEnv` object a service or app declared.
 *
 * Widens to {@link EnvValues} when nothing was declared, which
 * {@link OverlayEnvVarNames} then reads as "no extra keys".
 */
export type DeclaredStaticEnv<T> = "staticEnv" extends keyof T
	? NonNullable<T["staticEnv"]>
	: EnvValues;

/**
 * The object an app's own `envVars` builder returns.
 *
 * Widens to {@link EnvValues} when the app declares no builder or the builder's
 * return was already erased, so callers get "no extra keys" rather than an error.
 */
export type DeclaredAppEnvVars<TApp> = "envVars" extends keyof TApp
	? NonNullable<TApp["envVars"]> extends (...args: never[]) => infer TReturn
		? [TReturn] extends [EnvValues]
			? TReturn
			: EnvValues
		: EnvValues
	: EnvValues;

/**
 * `TApps` with every position that names a service or app key narrowed to this
 * config's own keys.
 *
 * The `envVars` parameters are spelled out with `NoInfer` rather than reused
 * from {@link EnvVarsBuilder}: a builder that reads `ports.web` would otherwise
 * make `TApps` an inference target from inside the very object it is inferred
 * from, and TypeScript resolves that circularity by falling back to the
 * `Record<string, AppConfig>` constraint — losing every app key. The return type
 * is carried over from the app's own declaration so `buildAppEnvVars` can see it.
 *
 * The `never` branch keeps the no-apps instantiation (`Record<string, never>`)
 * assignable to `Record<string, AppConfig>`; rewriting `never` would otherwise
 * drop the required `port` / `devCommand` members.
 */
export type TypedAppDefinitions<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> = {
	[K in keyof TApps]: [TApps[K]] extends [never]
		? TApps[K]
		: Omit<TApps[K], "requiredServices" | "requiredApps" | "envVars"> & {
				requiredServices?: readonly Extract<keyof TServices, string>[];
				requiredApps?: readonly Extract<keyof TApps, string>[];
				envVars?: (
					ports: NoInfer<
						ComputedPorts<TServices, TypedAppDefinitions<TServices, TApps>>
					>,
					urls: NoInfer<
						ComputedUrls<TServices, TypedAppDefinitions<TServices, TApps>>
					>,
					ctx: NoInfer<
						EnvVarsContext<TServices, TypedAppDefinitions<TServices, TApps>>
					>,
				) => DeclaredAppEnvVars<TApps[K]>;
			};
};

// ═══════════════════════════════════════════════════════════════════════════
// Hooks
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execution options for the exec helper.
 */
export interface ExecOptions {
	/** Working directory relative to monorepo root */
	cwd?: string;
	/** Print output to console */
	verbose?: boolean;
	/** Environment variables to add */
	env?: Record<string, string>;
	/** Throw on non-zero exit code (default: true) */
	throwOnError?: boolean;
}

/**
 * Result of a command run through `exec`/`execAsync`.
 */
export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Context passed to hooks for executing commands and accessing environment.
 */
export interface HookContext<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> {
	/** Project name (with suffix if applicable) */
	projectName: string;
	/** Computed ports for all services and apps */
	ports: ComputedPorts<TServices, TApps>;
	/** Computed URLs for all services and apps */
	urls: ComputedUrls<TServices, TApps>;
	/** `http://localhost:<port>` URLs, never rewritten by named hosts */
	loopbackUrls: ComputedLoopbackUrls<TServices, TApps>;
	/** Public tunnel URLs for exposed services/apps (when active) */
	publicUrls: ComputedPublicUrls<TServices, TApps>;
	/** Execute a shell command with environment variables set */
	exec: (
		cmd: string,
		options?: ExecOptions,
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
	/** Path to monorepo root */
	root: string;
	/** Whether running in CI environment */
	isCI: boolean;
	/** Port offset applied to all ports */
	portOffset: number;
	/** Local IP address for mobile connectivity */
	localIp: string;
}

/**
 * Lifecycle hooks for customizing the dev environment.
 */
export interface DevHooks<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> {
	/** Called after all containers are healthy */
	afterContainersReady?: (ctx: HookContext<TServices, TApps>) => Promise<void>;
	/** Called before starting dev servers */
	beforeServers?: (ctx: HookContext<TServices, TApps>) => Promise<void>;
	/** Called after dev servers are ready */
	afterServers?: (ctx: HookContext<TServices, TApps>) => Promise<void>;
	/** Called before stopping the environment */
	beforeStop?: (ctx: HookContext<TServices, TApps>) => Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Prisma Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for Prisma integration.
 */
export interface PrismaConfig<
	TServices extends Record<string, ServiceConfig> = Record<
		string,
		ServiceConfig
	>,
	TApps extends Record<string, AppConfig> = Record<string, AppConfig>,
> {
	/** Working directory where prisma schema lives (relative to monorepo root). Default: 'packages/prisma' */
	cwd?: string;
	/** Configured service key for the database. Default: 'postgres' */
	service?: Extract<keyof TServices, string>;
	/**
	 * Environment variable name for the database URL. Default: 'DATABASE_URL'
	 *
	 * Deliberately not keyed on the `env` overlay: that would make `DevConfig`
	 * invariant in its overlay type, so a narrowly typed config could no longer
	 * be handed to anything expecting the widened one.
	 */
	urlEnvVar?: ConfigEnvVarNames<TServices, TApps>;
	/**
	 * Command to run after migrations (e.g. Prisma 7 `prisma generate --sql`).
	 * Skipped when unset.
	 */
	generate?: string;
}

/**
 * Prisma runner interface available on dev.prisma when prisma is configured.
 */
export interface PrismaRunner {
	/** Run a prisma command with the correct environment. Returns exit code. */
	run(args: string[]): Promise<number>;
	/** Get the database URL from the dev environment */
	getDatabaseUrl(): string;
	/** Ensure the database container is running and healthy */
	ensureDatabase(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Migrations Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for a migration command to run after containers are ready.
 */
export interface MigrationConfig {
	/** Display name for the migration (e.g., 'prisma', 'clickhouse') */
	name: string;
	/** Command to run the migration */
	command: string;
	/** Working directory relative to monorepo root */
	cwd?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Seed Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Helper functions available in the seed check function.
 */
export interface SeedCheckHelpers<
	TServices extends Record<string, ServiceConfig>,
> {
	/**
	 * Check if a database table is empty.
	 * Returns true if the table has 0 rows (needs seeding), false otherwise.
	 *
	 * @param tableName - The table name to check (e.g., 'User')
	 * @param service - The database service name. Default: prisma.service or 'postgres'
	 *
	 * @example
	 * ```typescript
	 * seed: {
	 *   command: 'bun run run:seeder',
	 *   check: ({ checkTable }) => checkTable('User')
	 * }
	 * ```
	 */
	// Method syntax, not a function-typed property: `service` is keyed on the
	// config, so under `strictFunctionTypes` a property would make this helper
	// invariant in `TServices` — and a `check` callback written inside a
	// conditional spread is contextually typed against the widened default
	// instantiation before `TServices` is inferred. Bivariant parameters keep
	// the two mutually assignable.
	checkTable(tableName: string, service?: keyof TServices): Promise<boolean>;
}

/**
 * Context passed to the seed check function.
 */
export type SeedCheckContext<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> = HookContext<TServices, TApps> & SeedCheckHelpers<TServices>;

/**
 * Configuration for database seeding.
 */
export interface SeedConfig<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> {
	/** Command to run the seeder */
	command: string;
	/** Working directory relative to monorepo root */
	cwd?: string;
	/**
	 * Check function to determine if seeding is needed.
	 * Return true to run the seed command, false to skip.
	 * If not provided, seeding always runs.
	 *
	 * Receives hook context plus helper functions like `checkTable`.
	 *
	 * @example
	 * ```typescript
	 * seed: {
	 *   command: 'bun run run:seeder',
	 *   check: ({ checkTable }) => checkTable('User')
	 * }
	 * ```
	 */
	check?: (ctx: SeedCheckContext<TServices, TApps>) => Promise<boolean>;
	/**
	 * After a Bun seed module finishes, exit the seed process even if sockets or
	 * pools are still open. Default: true when `command` is a Bun script path.
	 */
	forceExit?: boolean;
}

/**
 * Options for {@link DevEnvironment.runSeed}.
 */
export interface SeedRunOptions {
	verbose?: boolean;
	productionBuild?: boolean;
	/** Skip `seed.check` — the caller asked for a seed explicitly. */
	force?: boolean;
}

/**
 * Result of the single seed path.
 *
 * `not-configured` means no `seed` block exists; `not-needed` means
 * `seed.check` returned false.
 */
export type SeedOutcome =
	| { status: "not-configured" }
	| { status: "not-needed" }
	| { status: "succeeded"; result: ExecResult }
	| { status: "failed"; result: ExecResult };

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
	 * Default: 180000 (3 minutes) when running via CLI.
	 *
	 * Also how long containers are held after a clean exit, so raise it if you
	 * routinely stop and restart `dev` with a longer gap than this.
	 */
	autoShutdown?: number | false;
	/** Default verbose setting for all operations. Default: true */
	verbose?: boolean;
	/** App key used by getExpoApiUrl(). Default: 'api' */
	expoApiApp?: Extract<keyof TApps, string>;
	/** App key used by getFrontendPort(). Default: 'platform', then 'web' */
	frontendApp?: Extract<keyof TApps, string>;
	/**
	 * Named `.localhost` HTTPS URLs via the shared loopback proxy.
	 * `true` uses defaults. Off on Windows, in CI, or when `BUNCARGO_HOSTS=0`.
	 */
	hosts?: boolean | HostsOptions<TServices, TApps>;
	/**
	 * Keep a dotenv on disk in step with the allocated ports, for tooling that
	 * reads `.env` instead of inheriting buncargo's environment.
	 * `true` uses `.env`. Off by default.
	 */
	envFile?: boolean | EnvFileOptions;
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
	publicUrls: ComputedPublicUrls<TServices, TApps>;
	/** `http://localhost:<port>` URLs, never rewritten by named hosts */
	loopbackUrls: ComputedLoopbackUrls<TServices, TApps>;
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
type ConcreteStringKeys<T> = string extends keyof T
	? never
	: Extract<keyof T, string>;

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
	/** Docker Compose generation options (optional) */
	docker?: DockerComposeGenerationOptions;
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
	"expoApiApp" | "frontendApp" | "hosts"
> & {
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
	>]?: (...args: never[]) => Promise<void>;
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
	[K in keyof TServices]: number;
} & {
	[K in keyof TApps]: number;
} & ServicesWithSecondaryPort<TServices>;

/**
 * URLs for every service and app, plus a `<app>Local` LAN URL per app.
 */
export type ComputedUrls<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> = {
	[K in keyof TServices]: string;
} & {
	[K in keyof TApps]: string;
} & {
	[K in keyof TApps as `${K & string}Local`]: string;
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
	[K in keyof TServices]: string;
} & {
	[K in keyof TApps]: string;
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
		| ServiceEnvVarNamesFromKey<Extract<K, string>>
		| ServiceEnvVarNamesFromPreset<TServices[K]>
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
	Partial<Record<HostOnlyEnvVarNames, string>>;

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
		| "PORT"
		| "HOST"
		| "BUNCARGO_APP_NAME",
		string
	> &
	Partial<Record<AppHostOnlyEnvVarNames, string>>;

// ═══════════════════════════════════════════════════════════════════════════
// Start/Stop Options
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for starting the dev environment.
 */
export interface StartOptions<
	TApps extends Record<string, AppConfig> = Record<string, AppConfig>,
> {
	/** Print output to console. Default: true */
	verbose?: boolean;
	/** Wait for containers to be healthy. Default: true */
	wait?: boolean;
	/** Start dev servers after containers. Default: true */
	startServers?: boolean;
	/** Use production build for servers. Default: false (true in CI) */
	productionBuild?: boolean;
	/** Skip automatic seeding (useful when CLI handles seeding separately). Default: false */
	skipSeed?: boolean;
	/** Skip the initial `logInfo` banner (CLI uses this with `--expose`, then logs once with tunnel URLs). Default: false */
	skipEnvironmentLog?: boolean;
	/** If set, start and wait for only these app names plus any transitive `requiredApps`. */
	onlyApps?: Extract<keyof TApps, string>[];
	/** Override Docker auto-start. Default: config.docker.autoStart (true, skipped in CI). */
	autoStartDocker?: boolean;
}

/**
 * Options for stopping the dev environment.
 */
export interface StopOptions {
	/** Print output to console. Default: true */
	verbose?: boolean;
	/** Remove Docker volumes (destroys data). Default: false */
	removeVolumes?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Dev Environment Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Process IDs for running dev servers.
 */
export interface DevServerPids {
	[appName: string]: number;
}

/** Tunnel rows passed to `logInfo` for public URL lines (matches `PublicTunnel` without `close`) */
export interface DevEnvironmentTunnelLog {
	kind: "service" | "app";
	name: string;
	localUrl: string;
	publicUrl: string;
}

/** Active tunnel with teardown — same shape as core `PublicTunnel`. */
export type PublicTunnelHandle = DevEnvironmentTunnelLog & {
	close: () => Promise<void>;
};

/** Options for {@link DevEnvironment.openPublicTunnels}. */
export interface OpenPublicTunnelsOptions<
	TServices extends Record<string, ServiceConfig> = Record<
		string,
		ServiceConfig
	>,
	TApps extends Record<string, AppConfig> = Record<string, AppConfig>,
> {
	/** Subset of expose targets by name; omit for all `expose: true` services/apps. */
	names?: Extract<ExposedKeys<TServices, TApps>, string>[];
	/**
	 * Wait for these apps' HTTP health endpoints before opening tunnels.
	 * Servers must already be listening on their ports.
	 */
	waitForHealthy?: Extract<keyof TApps, string>[];
}

/** Result of {@link DevEnvironment.openPublicTunnels}. */
export interface OpenPublicTunnelsResult<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> {
	publicUrls: ComputedPublicUrls<TServices, TApps>;
	tunnels: PublicTunnelHandle[];
	close: () => Promise<void>;
}

/**
 * The main dev environment interface returned by createDevEnvironment().
 */
export interface DevEnvironment<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues = EnvValues,
> {
	// ─────────────────────────────────────────────────────────────────────────
	// Configuration Access
	// ─────────────────────────────────────────────────────────────────────────

	/** Docker project name (includes suffix if set) */
	readonly projectName: string;
	/** Computed ports for all services and apps */
	readonly ports: ComputedPorts<TServices, TApps>;
	/** Computed URLs for all services and apps */
	readonly urls: ComputedUrls<TServices, TApps>;
	/**
	 * `http://localhost:<port>` URLs, never rewritten by named hosts.
	 *
	 * For tooling that cannot use the named HTTPS host because it does not
	 * trust the local CA: Playwright, the Stripe CLI, GUI database clients.
	 */
	readonly loopbackUrls: ComputedLoopbackUrls<TServices, TApps>;
	/** Public tunnel URLs for exposed services/apps (when active) */
	readonly publicUrls: ComputedPublicUrls<TServices, TApps>;
	/** Services configuration */
	readonly services: TServices;
	/** Apps configuration (for CLI to build commands) */
	readonly apps: TApps;
	/** Port offset applied (0 for main, > 0 for worktrees) */
	readonly portOffset: number;
	/** How the port offset was chosen */
	readonly portOffsetProvenance: PortOffsetProvenance;
	/** Whether running in a git worktree */
	readonly isWorktree: boolean;
	/** Local IP address for mobile connectivity */
	readonly localIp: string;
	/** Path to monorepo root */
	readonly root: string;
	/** Path passed to docker compose -f */
	readonly composeFile: string;
	/** Named-hosts plan and whether the loopback proxy is serving it */
	readonly hosts: HostsRuntime | null;
	/** Seed command from config, when present */
	readonly seed?: Pick<SeedConfig<TServices, TApps>, "command" | "cwd">;

	// ─────────────────────────────────────────────────────────────────────────
	// Container Management
	// ─────────────────────────────────────────────────────────────────────────

	/** Start the dev environment (containers + optional servers) */
	start(options?: StartOptions<TApps>): Promise<DevServerPids | null>;
	/** Stop the dev environment */
	stop(options?: StopOptions): Promise<void>;
	/** Restart containers only */
	restart(): Promise<void>;
	/** Check if containers are running */
	isRunning(): Promise<boolean>;
	/**
	 * Run `seed.command` through the same path `start()` uses.
	 *
	 * Pass `force: true` to skip `seed.check`. Returns the outcome rather than
	 * throwing, so callers choose their own failure behavior.
	 */
	runSeed(options?: SeedRunOptions): Promise<SeedOutcome>;

	// ─────────────────────────────────────────────────────────────────────────
	// Server Management
	// ─────────────────────────────────────────────────────────────────────────

	/** Start dev servers only (assumes containers are running) */
	startServers(options?: {
		productionBuild?: boolean;
		verbose?: boolean;
		/** If set, start and wait for only these app names plus any transitive `requiredApps`. */
		onlyApps?: Extract<keyof TApps, string>[];
	}): Promise<DevServerPids>;
	/** Stop a process by PID */
	stopProcess(pid: number): void;
	/** Wait for servers to be ready */
	waitForServers(options?: {
		timeout?: number;
		productionBuild?: boolean;
		/** If set, wait only for these app names plus any transitive `requiredApps`. */
		onlyApps?: Extract<keyof TApps, string>[];
		/** When false, do not expand `onlyApps` via `requiredApps`. Default: true */
		expandRequired?: boolean;
	}): Promise<void>;
	/** Idle watchdog timeout from `options.autoShutdown` (ms), or false to disable. */
	readonly autoShutdown?: number | false;

	// ─────────────────────────────────────────────────────────────────────────
	// Utilities
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Build the shared environment variables for shell commands.
	 *
	 * Keys are the computed names ({@link ConfigEnvVarNames}) plus whatever
	 * `config.env` declared, so an unknown name is a compile error.
	 *
	 * Call **after** {@link setPublicUrls} or {@link openPublicTunnels} so `*_PUBLIC_URL` values reflect tunnel URLs.
	 */
	buildEnvVars(production?: boolean): ComputedEnvVars<TServices, TApps, TEnv>;
	/** Build the full environment for a specific app process (`shared env + apps[name].envVars`). */
	buildAppEnvVars<TName extends Extract<keyof TApps, string>>(
		appName: TName,
		production?: boolean,
	): AppEnvVars<TServices, TApps, TEnv, TName>;
	/** Set public tunnel URLs used by envVars and *_PUBLIC_URL injection */
	setPublicUrls(urls: ComputedPublicUrls<TServices, TApps>): void;
	/** Clear all public tunnel URLs */
	clearPublicUrls(): void;
	/** Switch `urls` between localhost:port and named HTTPS hostnames */
	setNamedHostsActive(active: boolean, extras?: { caPath?: string }): void;
	/** Ensure generated docker compose file exists and return path used with -f */
	ensureComposeFile(): string;
	/** Execute a command with environment variables set */
	exec(
		cmd: string,
		options?: ExecOptions,
	): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	/** Wait for an HTTP server to respond */
	waitForServer(url: string, timeout?: number): Promise<void>;
	/** Log environment info to console; pass `tunnels` to show public URLs next to services/apps */
	logInfo(label?: string, tunnels?: DevEnvironmentTunnelLog[]): void;

	/**
	 * Resolve expose targets, start public quick tunnels, and apply {@link setPublicUrls}.
	 * Call {@link buildEnvVars} or {@link buildAppEnvVars} after this resolves when spawning processes that need `*_PUBLIC_URL`.
	 */
	openPublicTunnels(
		options?: OpenPublicTunnelsOptions<TServices, TApps>,
	): Promise<OpenPublicTunnelsResult<TServices, TApps>>;

	// ─────────────────────────────────────────────────────────────────────────
	// Vibe Kanban Integration
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Get the Expo API URL (http://<local-ip>:<api-port>) and log it for detection.
	 * Used by tools like Vibe Kanban to find the API server for mobile testing.
	 */
	getExpoApiUrl(): string;

	/**
	 * Get the frontend port and log it for detection.
	 * Used by tools like Vibe Kanban to find the dev server.
	 */
	getFrontendPort(): number | undefined;

	// ─────────────────────────────────────────────────────────────────────────
	// Watchdog / Heartbeat
	// ─────────────────────────────────────────────────────────────────────────

	/** Start writing heartbeat for watchdog */
	startHeartbeat(intervalMs?: number): void;
	/** Stop writing heartbeat */
	stopHeartbeat(): void;
	/** Spawn watchdog process for auto-shutdown */
	spawnWatchdog(timeoutMinutes?: number): Promise<void>;
	/** Stop the watchdog process */
	stopWatchdog(): void;

	// ─────────────────────────────────────────────────────────────────────────
	// Prisma Integration
	// ─────────────────────────────────────────────────────────────────────────

	/** Prisma runner (only available when prisma is configured) */
	readonly prisma?: PrismaRunner;

	// ─────────────────────────────────────────────────────────────────────────
	// Advanced
	// ─────────────────────────────────────────────────────────────────────────

	/** Create a new environment with a different suffix (for test isolation) */
	withSuffix(suffix: string): DevEnvironment<TServices, TApps, TEnv>;
}

/**
 * Any dev environment, with service/app keys unknown.
 *
 * The name-keyed option types are widened back to `string` rather than left at
 * the `Record<string, …>` instantiation: `names?: Extract<ExposedKeys<…>>[]`
 * puts app keys in a parameter position, and a concrete environment would not
 * be assignable to the widened one otherwise.
 */
export interface AnyDevEnvironment
	extends Omit<
		DevEnvironment<
			Record<string, ServiceConfig>,
			Record<string, AppConfig>,
			EnvValues
		>,
		"openPublicTunnels" | "withSuffix"
	> {
	openPublicTunnels(options?: {
		names?: string[];
		waitForHealthy?: string[];
	}): Promise<
		OpenPublicTunnelsResult<
			Record<string, ServiceConfig>,
			Record<string, AppConfig>
		>
	>;
	withSuffix(suffix: string): AnyDevEnvironment;
}

/**
 * The {@link DevEnvironment} produced by a given config type.
 *
 * Lets programmatic consumers keep `defineDevConfig` inference through the
 * loader, which imports the config at runtime and cannot infer it:
 *
 * ```ts
 * import type devConfig from "./dev.config";
 * const env = await loadDevEnv<typeof devConfig>();
 * env.urls.api; // typed
 * ```
 */
export type DevEnvironmentFor<TConfig extends DevConfigLike> =
	TConfig extends DevConfig<infer TServices, infer TApps, infer TEnv>
		? DevEnvironment<TServices, TApps, TEnv>
		: AnyDevEnvironment;

// ═══════════════════════════════════════════════════════════════════════════
// CLI Options
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How the port offset was chosen.
 */
export type PortOffsetProvenance = "hash" | "lockfile" | "env" | "shifted";

/**
 * Options for the CLI runner.
 */
export interface CliOptions {
	/** Custom args (defaults to process.argv.slice(2)) */
	args?: string[];
	/** Enable watchdog auto-shutdown (default: true). Tests set false. */
	watchdog?: boolean;
}
