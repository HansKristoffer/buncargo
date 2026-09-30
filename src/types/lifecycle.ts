import type { AppConfig } from "./app";
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
	/** Use production build for servers. Default: false (true in CI) */
	productionBuild?: boolean;
	/** Cancel startup, including preparation commands and readiness. */
	signal?: AbortSignal;
	/** Preparation mode; containers skips migrations, generation and seeding. */
	prepare?: "all" | "containers" | "migrate";
	/** Report completed startup phases without coupling the library to CLI output. */
	onPhase?: (name: string, durationMs: number) => void;
	/** Skip automatic seeding (useful when CLI handles seeding separately). Default: false */
	skipSeed?: boolean;
	/** Skip the initial `logInfo` banner (CLI uses this with `--expose`, then logs once with tunnel URLs). Default: false */
	skipEnvironmentLog?: boolean;
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
}
