import type { IntegrationAppNames } from "./all-types";
import type { AppConfig, CaptureConfig, SecretsScopeConfig } from "./app";
import type { PortOffsetProvenance } from "./cli";
import type {
	GeneratedFileConfig,
	ProfileConfig,
	SetupCheck,
	TaskConfig,
} from "./commands";
import type {
	AppEnvVars,
	ComputedEnvVars,
	ComputedLoopbackUrls,
	ComputedPorts,
	ComputedPublicUrls,
	ComputedUrls,
	ConfigEnvVarNames,
	ExposedKeys,
} from "./computed";
import type {
	DevConfig,
	DevConfigLike,
	EnvValues,
	HostsRuntime,
} from "./config";
import type { ExecOptions } from "./hooks";
import type { BuncargoIntegration } from "./integrations";
import type { StartOptions, StopOptions } from "./lifecycle";
import type {
	PrismaRunner,
	SeedConfig,
	SeedOutcome,
	SeedRunOptions,
} from "./preparation";
import type {
	ComposeDocument,
	ContainerRuntimeName,
	ServiceConfig,
} from "./service";

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

/** The apps and service prerequisites shown in a run's banner. */
export interface EnvironmentLogSelection {
	appNames: readonly string[];
	requiredServiceKeys: readonly string[];
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
	signal?: AbortSignal;
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
	/** The configured `projectPrefix`, before the directory and worktree suffixes. */
	readonly projectPrefix: string;
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
	readonly workspaceId?: string;
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
	/** Validate selection and resolve startup allocation before activating hosts. */
	prepareStart?(
		onlyApps?: Extract<keyof TApps, string>[],
		onlyServices?: readonly Extract<keyof TServices, string>[],
	): void;
	/** Which backend runs the containers: 'docker' or 'apple' */
	readonly containerRuntime: ContainerRuntimeName;
	/** Cancellable startup allocation; prefer this when preparing before host activation. */
	prepareStartAsync?(
		onlyApps?: Extract<keyof TApps, string>[],
		onlyServices?: readonly Extract<keyof TServices, string>[],
		signal?: AbortSignal,
	): Promise<void>;

	/** Binary the runtime was resolved to, when overridden off `PATH` */
	readonly containerRuntimeBinary?: string;
	/** Named-hosts plan and whether the loopback proxy is serving it */
	readonly hosts: HostsRuntime | null;
	/** Seed command from config, when present */
	readonly seed?: Pick<
		SeedConfig<TServices, TApps>,
		"command" | "cwd" | "beforeApps" | "requiredServices"
	>;
	/** `checks` from config and its integrations, run by `buncargo dev` before it starts anything */
	readonly checks?: readonly SetupCheck[];
	/** The config's integrations, after they have been applied. */
	readonly integrations?: readonly BuncargoIntegration[];
	/** `generatedFiles` from config and its integrations */
	readonly generatedFiles?: readonly GeneratedFileConfig[];
	/** Values apps printed (`captures`), by name. */
	readonly captured: Readonly<Record<string, string>>;
	/**
	 * Record a value an app printed: update `captured` / `publicUrls`, fire
	 * `onCapture` hooks and re-render generated files. Returns what changed
	 * (`captured.<name>`, `publicUrls.<app>`). For callers that spawn apps
	 * themselves; `buncargo dev` and `startServers` do it already.
	 */
	recordCapture(
		app: string,
		captured: { name: string; value: string; as: CaptureConfig["as"] },
	): Promise<readonly string[]>;
	/** Render every generated file; returns the paths whose content changed. */
	renderGeneratedFiles(): string[];
	/** Labelled values for humans: labelled captures, then every integration's `describe`. */
	details(): Record<string, string>;
	/** The config-level Infisical scope (`secrets`), when configured. */
	readonly secrets?: SecretsScopeConfig;
	/** `tasks` from config, for `buncargo run` */
	readonly tasks?: Readonly<
		Record<
			string,
			TaskConfig<Extract<keyof TServices, string>, Extract<keyof TApps, string>>
		>
	>;
	/** `profiles` from config, for `buncargo dev --profile` */
	readonly profiles?: Readonly<
		Record<
			string,
			ProfileConfig<
				| Extract<keyof TApps, string>
				| Extract<keyof IntegrationAppNames, string>
			>
		>
	>;

	// ─────────────────────────────────────────────────────────────────────────
	// Container Management
	// ─────────────────────────────────────────────────────────────────────────

	/** Start the dev environment (containers + optional servers) */
	start(
		options?: StartOptions<TApps, TServices>,
	): Promise<DevServerPids | null>;
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
		signal?: AbortSignal;
		productionBuild?: boolean;
		verbose?: boolean;
		/** If set, start and wait for only these app names plus any transitive `requiredApps`. */
		onlyApps?: Extract<keyof TApps, string>[];
	}): Promise<DevServerPids>;
	/** Stop a process by PID */
	stopProcess(pid: number): void;
	/** Wait for servers to be ready */
	/** Run lifecycle hooks for callers that supervise servers themselves. */
	runServerHook?(
		phase: "before" | "after",
		signal?: AbortSignal,
	): Promise<void>;
	waitForServers(options?: {
		signal?: AbortSignal;
		timeout?: number;
		productionBuild?: boolean;
		/** If set, wait only for these app names plus any transitive `requiredApps`. */
		onlyApps?: Extract<keyof TApps, string>[];
		/** When false, do not expand `onlyApps` via `requiredApps`. Default: true */
		expandRequired?: boolean;
		/** Defer the aggregate ready message until other preparation completes. */
		logReady?: boolean;
	}): Promise<void>;

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
	/**
	 * The app this project is "about", optionally narrowed to a running set.
	 *
	 * A method rather than a field because the answer depends on which apps a
	 * run actually started: `--apps=api` makes `api` primary for that run.
	 */
	resolvePrimaryApp(
		selected?: readonly string[],
	): Extract<keyof TApps, string> | undefined;
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
	/** The service model the compose file is rendered from */
	composeModel(): ComposeDocument;
	/** Execute a command with environment variables set */
	exec(
		cmd: string | readonly string[],
		options?: ExecOptions,
	): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	/** Wait for an HTTP server to respond */
	waitForServer(url: string, timeout?: number): Promise<void>;
	/** Log environment info to console; pass `tunnels` to show public URLs next to services/apps */
	logInfo(
		label?: string,
		tunnels?: DevEnvironmentTunnelLog[],
		selection?: EnvironmentLogSelection,
	): void;

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
	// Run claim / watchdog
	// ─────────────────────────────────────────────────────────────────────────

	/** The session this environment publishes under, in `~/.buncargo/runs.json`. */
	readonly sessionId: string;
	/**
	 * Claim the selected services' containers for this process.
	 *
	 * `start()` does this itself; call it first to set the idle hold, where
	 * `false` keeps the containers as long as the checkout exists. Idempotent.
	 */
	claimRun(options?: {
		signal?: AbortSignal;
		idleTimeoutMs?: number | false;
		/** The hold when neither `idleTimeoutMs` nor `options.autoShutdown` gives one. */
		defaultIdleTimeoutMs?: number | false;
	}): Promise<void>;
	/** Release the claim: containers are held for the idle timeout, then removed. */
	releaseRun(): Promise<void>;
	/** Start the machine-wide watchdog unless it is already running. */
	ensureWatchdog(): Promise<void>;

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
