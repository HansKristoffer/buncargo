import type { AppConfig } from "./app";
import type { SeedOutcome } from "./preparation";
import type { ServiceConfig } from "./service";

// ═══════════════════════════════════════════════════════════════════════════
// Start/Stop Options
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for starting the dev environment.
 */
export interface StartOptions<
	TApps extends Record<string, AppConfig> = Record<string, AppConfig>,
	TServices extends Record<string, ServiceConfig> = Record<
		string,
		ServiceConfig
	>,
> {
	/** Print output to console. Default: true */
	verbose?: boolean;
	/** Wait for containers to be healthy. Default: true */
	wait?: boolean;
	/** Start dev servers after containers. Default: true */
	startServers?: boolean;
	/**
	 * Build and run the apps' production commands, and give the containers,
	 * migrations, seed and apps the production env (`NODE_ENV=production`).
	 * Default: true in CI when this start runs the servers, else false.
	 */
	productionBuild?: boolean;
	/** Cancel startup, including preparation commands and readiness. */
	signal?: AbortSignal;
	/** Preparation mode; containers skips migrations, generation and seeding. */
	prepare?: "all" | "containers" | "migrate";
	/** Report completed startup phases without coupling the library to CLI output. */
	onPhase?: (name: string, durationMs: number) => void;
	/**
	 * The seed. `"auto"` (default) runs it when `seed.check` says so, beside
	 * the apps with `seed.beforeApps: false`. `"force"` runs it before the
	 * apps whatever `seed.check` says. `"skip"` leaves it out.
	 */
	seed?: "auto" | "force" | "skip";
	/**
	 * How the Prisma schema reaches the database: `"migrate"` (default) runs
	 * `prisma migrate deploy`, `"push"` runs `prisma db push` in its place, for
	 * a throwaway database (`buncargo ci --schema=push`). The other
	 * `migrations` and the hooks run either way.
	 */
	schema?: "migrate" | "push";
	/**
	 * The hold the run claims its containers with: how long they outlive it.
	 * `idleTimeoutMs: false` keeps them as long as the checkout exists.
	 * Default: kept, unless `options.autoShutdown` or `defaultIdleTimeoutMs`
	 * gives a hold.
	 */
	claim?: {
		idleTimeoutMs?: number | false;
		/** The hold when neither `idleTimeoutMs` nor `options.autoShutdown` gives one. */
		defaultIdleTimeoutMs?: number | false;
	};
	/** If set, start and wait for only these app names plus any transitive `requiredApps`. */
	onlyApps?: Extract<keyof TApps, string>[];
	/**
	 * Start only these services (plus their Compose dependencies) and no apps.
	 * Takes precedence over `onlyApps`; preparation is scoped to them as usual.
	 */
	onlyServices?: readonly Extract<keyof TServices, string>[];
	/** Override Docker auto-start. Default: config.docker.autoStart (true, skipped in CI). */
	autoStartDocker?: boolean;
	/**
	 * Before allocating ports, remove the containers of stacks this checkout
	 * left under a project name it no longer uses (its `projectPrefix`
	 * changed), so they stop holding its ports. Volumes are kept, and a stack
	 * of another checkout or of a live run is never touched. Default: false.
	 */
	replaceStaleStacks?: boolean;
	/**
	 * Start the machine-wide watchdog that removes these containers once this
	 * process is gone. Default: true. The run claims its containers either
	 * way; `false` only skips starting the process, for tests that must not
	 * leave one behind.
	 */
	watchdog?: boolean;
}

/**
 * Options for stopping the dev environment.
 */
export interface StopOptions {
	signal?: AbortSignal;
	/** Print output to console. Default: true */
	verbose?: boolean;
	/** Remove Docker volumes (destroys data). Default: false */
	removeVolumes?: boolean;
	/**
	 * Tear the services down even while another live run of this project
	 * uses them. Default: false, which stops this environment's apps and
	 * releases its claim, leaving the services to that run.
	 */
	force?: boolean;
}

/** Options for {@link DevEnvironment.withServices}. */
export interface WithServicesOptions extends Pick<
	StartOptions,
	| "signal"
	| "verbose"
	| "wait"
	| "seed"
	| "schema"
	| "claim"
	| "watchdog"
	| "onPhase"
> {
	/**
	 * What the services get ready for: `"containers"` (default) only starts
	 * them; `"all"` also runs the migrations, generation and the seed.
	 */
	prepare?: "containers" | "all";
	/**
	 * What happens to the services once the command ends. `"release"`
	 * (default) hands them to the claim's idle hold; `"stop"` tears them
	 * down, as {@link StopOptions} `removeVolumes` says.
	 */
	after?: "release" | { stop: Pick<StopOptions, "removeVolumes"> };
}

/** What {@link DevEnvironment.withServices} hands its command. */
export interface ServicesStarted {
	/** The seed's outcome, when `seed: "force"` ran it. */
	readonly seed?: SeedOutcome;
}
