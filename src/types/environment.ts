import type { AppConfig, SecretsScopeConfig } from "./app";
import type { PortOffsetProvenance } from "./cli";
import type { GeneratedFileConfig, ProfileConfig } from "./commands";
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
	CheckoutFile,
	DevConfig,
	DevConfigLike,
	EnvValues,
	HostsRuntime,
} from "./config";
import type { ExecOptions } from "./hooks";
import type { BuncargoIntegration } from "./integrations";
import type {
	ServicesStarted,
	StartOptions,
	StopOptions,
	WithServicesOptions,
} from "./lifecycle";
import type { PrismaRunner, SeedOutcome, SeedRunOptions } from "./preparation";
import type { ResolvedApps, ResolvedServices } from "./resolved";
import type { ContainerRuntimeName, ServiceConfig } from "./service";

// ═══════════════════════════════════════════════════════════════════════════
// Dev Environment Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Process IDs of the dev servers a start spawned, by app. An app it did not
 * spawn (reused, left out, or with no `devCommand`) has none.
 */
export type DevServerPids<
	TApps extends Record<string, AppConfig> = Record<string, AppConfig>,
> = { [TName in Extract<keyof TApps, string>]?: number };

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

/** Active tunnel with teardown; core `PublicTunnel` is this type. */
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
	/** Stable id of this checkout, which apps see as `BUNCARGO_WORKSPACE_ID`. */
	readonly workspaceId: string;
	/** The config's services, resolved: one kind each, every default filled. */
	readonly services: ResolvedServices<TServices>;
	/** The config's apps, resolved: one kind each, every default filled. */
	readonly apps: ResolvedApps<TApps>;
	/** Port offset applied (0 for main, > 0 for worktrees) */
	readonly portOffset: number;
	/** How the port offset was chosen */
	readonly portOffsetProvenance: PortOffsetProvenance;
	/** Whether running in a git worktree */
	readonly isWorktree: boolean;
	/** `options.worktreeIsolation`: whether worktrees get stacks of their own. */
	readonly worktreeIsolation: boolean;
	/** Local IP address for mobile connectivity */
	readonly localIp: string;
	/** Path to monorepo root */
	readonly root: string;
	/** Path passed to docker compose -f */
	readonly composeFile: string;
	/** Which backend runs the containers: 'docker' or 'apple' */
	readonly containerRuntime: ContainerRuntimeName;
	/** Validate the selection and allocate for it before activating hosts; cancellable. */
	prepareStartAsync(
		onlyApps?: Extract<keyof TApps, string>[],
		onlyServices?: readonly Extract<keyof TServices, string>[],
		signal?: AbortSignal,
	): Promise<void>;

	/** Binary the runtime was resolved to, when overridden off `PATH` */
	readonly containerRuntimeBinary?: string;
	/** Named-hosts plan and whether the loopback proxy is serving it */
	readonly hosts: HostsRuntime | null;
	/** The config's integrations, after they have been applied. */
	readonly integrations?: readonly BuncargoIntegration[];
	/** `options.checkoutFiles` from config */
	readonly checkoutFiles?: readonly CheckoutFile[];
	/** `generatedFiles` from config and its integrations */
	readonly generatedFiles?: readonly GeneratedFileConfig[];
	/** Values apps printed (`captures`), by name. */
	readonly captured: Readonly<Record<string, string>>;
	/** Labelled values for humans: labelled captures, then every integration's `describe`. */
	details(): Record<string, string>;
	/** The config-level Infisical scope (`secrets`), when configured. */
	readonly secrets?: SecretsScopeConfig | false;
	/** `options.onAppFailure` from config, for `buncargo dev` */
	readonly onAppFailure?: "keep-others" | "stop-run";
	/** `profiles` from config, for `buncargo dev --profile`; may name integration apps. */
	readonly profiles?: Readonly<Record<string, ProfileConfig>>;

	// ─────────────────────────────────────────────────────────────────────────
	// Container Management
	// ─────────────────────────────────────────────────────────────────────────

	/** Start the dev environment (containers + optional servers) */
	start(
		options?: StartOptions<TApps, TServices>,
	): Promise<DevServerPids<TApps> | null>;
	/**
	 * Stop the dev environment: its apps, then its services. While another
	 * live run of the project uses the services, they stay up for it and this
	 * environment only releases its claim; `force` tears them down anyway.
	 */
	stop(options?: StopOptions): Promise<void>;
	/**
	 * Start these services for a command, run it, then release them to the
	 * idle hold (or stop them, with `after: "stop"`), however it ends. The
	 * run is claimed before the first container, with `options.claim`'s hold.
	 */
	withServices<T>(
		services: readonly Extract<keyof TServices, string>[],
		options: WithServicesOptions,
		command: (started: ServicesStarted) => Promise<T>,
	): Promise<T>;
	/**
	 * Whether the services are up: every Compose service's container running
	 * (a `kind: "job"` one has done its work and exited), and every
	 * integration stack brought up by a start of this environment since its
	 * last stop.
	 */
	isRunning(): Promise<boolean>;
	/**
	 * Why the selected services' containers are gone, when they are: who
	 * removed them since this run claimed them, as buncargo recorded it, or
	 * where to look when nothing here did. `undefined` while they are all
	 * there or the runtime cannot answer. Lists the runtime's containers, so
	 * call it when something has already failed.
	 */
	explainMissingContainers(): Promise<string | undefined>;
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
	}): Promise<DevServerPids<TApps>>;
	/** Wait for servers to be ready */
	waitForServers(options?: {
		signal?: AbortSignal;
		productionBuild?: boolean;
		/** If set, wait only for these app names plus any transitive `requiredApps`. */
		onlyApps?: Extract<keyof TApps, string>[];
		/** When false, do not expand `onlyApps` via `requiredApps`. Default: true */
		expandRequired?: boolean;
		/** Defer the aggregate ready message until other preparation completes. */
		logReady?: boolean;
		/** Say "Waiting for servers to be ready..." when the wait is slow. Default: true */
		verbose?: boolean;
		/** Called as each app passes its health check, before the rest have. */
		onAppReady?: (name: string) => void;
	}): Promise<void>;

	// ─────────────────────────────────────────────────────────────────────────
	// Utilities
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * The app this project is "about", optionally narrowed to a running set.
	 *
	 * A method rather than a field because the answer depends on which apps a
	 * run actually started: `--apps=api` makes `api` primary for that run.
	 */
	resolvePrimaryApp(
		selected?: readonly string[],
	): Extract<keyof TApps, string> | undefined;
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
	/**
	 * A digest of {@link buildAppEnvVars} that is the same in every checkout and
	 * on every machine: ports, IP addresses, the project name, the workspace id
	 * and the checkout root are left out. Key a build cache on it to share a
	 * build between checkouts or CI runners. Only correct when the build does not
	 * bake in any of those values (an API URL with a port, for instance): leave
	 * them out of the build's env first.
	 */
	buildEnvFingerprint(
		appName: Extract<keyof TApps, string>,
		production?: boolean,
	): string;
	/** Set public tunnel URLs used by envVars and *_PUBLIC_URL injection */
	setPublicUrls(urls: ComputedPublicUrls<TServices, TApps>): void;
	/** Clear all public tunnel URLs */
	clearPublicUrls(): void;
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

	/**
	 * Create a new environment with a different suffix (for test isolation).
	 * `data: "tmpfs"` keeps its services' data in memory, so its stack leaves
	 * no volume behind (`buncargo ci`).
	 */
	withSuffix(
		suffix: string,
		options?: SuffixedEnvironmentOptions,
	): DevEnvironment<TServices, TApps, TEnv>;
}

/** Options for {@link DevEnvironment.withSuffix}. */
export interface SuffixedEnvironmentOptions {
	/**
	 * Where its services keep their data. `"tmpfs"` mounts in memory every
	 * volume the stack would own; bind mounts and `external` volumes stay.
	 * Default: `"volumes"`.
	 */
	data?: "volumes" | "tmpfs";
	/**
	 * Where its services publish. `"assigned"` lets the runtime pick each
	 * host port (`127.0.0.1::5432`); `ports`, `urls` and the environment use
	 * the ports read back once the containers are up. Docker only: on Apple
	 * `container` the stack keeps its claimed ports. Default: `"claimed"`.
	 */
	ports?: "claimed" | "assigned";
}

/**
 * Any dev environment, with service/app keys unknown.
 *
 * The name-keyed option types are widened back to `string` rather than left at
 * the `Record<string, …>` instantiation: `names?: Extract<ExposedKeys<…>>[]`
 * puts app keys in a parameter position, and a concrete environment would not
 * be assignable to the widened one otherwise.
 */
export interface AnyDevEnvironment extends Omit<
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
	withSuffix(
		suffix: string,
		options?: SuffixedEnvironmentOptions,
	): AnyDevEnvironment;
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
