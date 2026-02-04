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

/**
 * Configuration for a Docker Compose service (e.g., postgres, redis).
 */
export interface ServiceConfig {
	/** Base port for the service (before offset is applied) */
	port: number;
	/** Optional secondary port (e.g., ClickHouse native protocol) */
	secondaryPort?: number;
	/** Health check: built-in name, custom function, or disabled (false) */
	healthCheck?: BuiltInHealthCheck | HealthCheckFn | false;
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
}

// ═══════════════════════════════════════════════════════════════════════════
// App Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for an application (e.g., api, web).
 */
export interface AppConfig {
	/** Base port for the app (before offset is applied) */
	port: number;
	/** Command to start the dev server */
	devCommand: string;
	/** Command to start production server (optional) */
	prodCommand?: string;
	/** Command to build for production (optional) */
	buildCommand?: string;
	/** Working directory relative to monorepo root */
	cwd?: string;
	/** Health check endpoint path (e.g., '/api/health') */
	healthEndpoint?: string;
	/** Timeout for health check in milliseconds */
	healthTimeout?: number;
}

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
export interface PrismaConfig {
	/** Working directory where prisma schema lives (relative to monorepo root). Default: 'packages/prisma' */
	cwd?: string;
	/** Docker Compose service name for the database. Default: 'postgres' */
	service?: string;
	/** Environment variable name for the database URL. Default: 'DATABASE_URL' */
	urlEnvVar?: string;
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
	 * @param service - The database service name. Default: 'postgres'
	 *
	 * @example
	 * ```typescript
	 * seed: {
	 *   command: 'bun run run:seeder',
	 *   check: ({ checkTable }) => checkTable('User')
	 * }
	 * ```
	 */
	checkTable: (tableName: string, service: keyof TServices) => Promise<boolean>;
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
}

// ═══════════════════════════════════════════════════════════════════════════
// Dev Config
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for the dev environment.
 */
export interface DevOptions {
	/** Enable worktree isolation (unique ports per worktree). Default: true */
	worktreeIsolation?: boolean;
	/** Auto-shutdown after idle time in ms. Set to false to disable. Default: false */
	autoShutdown?: number | false;
	/** Path to docker-compose.yml relative to root. Default: 'docker-compose.yml' */
	composeFile?: string;
	/** Default verbose setting for all operations. Default: true */
	verbose?: boolean;
}

/**
 * Environment variable builder function.
 */
export type EnvVarsBuilder<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> = (
	ports: ComputedPorts<TServices, TApps>,
	urls: ComputedUrls<TServices, TApps>,
	ctx: { projectName: string; localIp: string; portOffset: number },
) => Record<string, string | number>;

/**
 * Main configuration for the dev environment.
 */
export interface DevConfig<
	TServices extends Record<string, ServiceConfig> = Record<
		string,
		ServiceConfig
	>,
	TApps extends Record<string, AppConfig> = Record<string, AppConfig>,
> {
	/** Prefix for Docker project name (e.g., 'myapp' -> 'myapp-main') */
	projectPrefix: string;
	/** Docker Compose services to manage */
	services: TServices;
	/** Applications to start (optional) */
	apps?: TApps;
	/**
	 * Environment variables builder. Define all env vars here.
	 *
	 * @example
	 * ```typescript
	 * envVars: (ports, urls, { localIp }) => ({
	 *   DATABASE_URL: urls.postgres,
	 *   BASE_URL: urls.api,
	 *   VITE_PORT: ports.platform,
	 *   EXPO_API_URL: `http://${localIp}:${ports.api}`
	 * })
	 * ```
	 */
	envVars?: EnvVarsBuilder<TServices, TApps>;
	/** Lifecycle hooks (optional) */
	hooks?: DevHooks<TServices, TApps>;
	/** Migrations to run after containers are ready (optional). Runs in parallel. */
	migrations?: MigrationConfig[];
	/** Seed configuration (optional). Runs after migrations, before servers. */
	seed?: SeedConfig<TServices, TApps>;
	/** Prisma configuration (optional). When set, dev.prisma is available. */
	prisma?: PrismaConfig;
	/** Additional options (optional) */
	options?: DevOptions;
}

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

export type ComputedPorts<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> = {
	[K in keyof TServices]: number;
} & {
	[K in keyof TApps]: number;
} & ServicesWithSecondaryPort<TServices>;

/**
 * Computed URLs object - maps service/app names to their URLs.
 */
export type ComputedUrls<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> = {
	[K in keyof TServices]: string;
} & {
	[K in keyof TApps]: string;
};

// ═══════════════════════════════════════════════════════════════════════════
// Start/Stop Options
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for starting the dev environment.
 */
export interface StartOptions {
	/** Print output to console. Default: true */
	verbose?: boolean;
	/** Wait for containers to be healthy. Default: true */
	wait?: boolean;
	/** Start dev servers after containers. Default: true */
	startServers?: boolean;
	/** Use production build for servers. Default: false (true in CI) */
	productionBuild?: boolean;
	/** Environment suffix for isolation (e.g., 'test'). Default: undefined */
	suffix?: string;
	/** Skip automatic seeding (useful when CLI handles seeding separately). Default: false */
	skipSeed?: boolean;
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

/**
 * The main dev environment interface returned by createDevEnvironment().
 */
export interface DevEnvironment<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
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
	/** Apps configuration (for CLI to build commands) */
	readonly apps: TApps;
	/** Port offset applied (0 for main, > 0 for worktrees) */
	readonly portOffset: number;
	/** Whether running in a git worktree */
	readonly isWorktree: boolean;
	/** Local IP address for mobile connectivity */
	readonly localIp: string;
	/** Path to monorepo root */
	readonly root: string;

	// ─────────────────────────────────────────────────────────────────────────
	// Container Management
	// ─────────────────────────────────────────────────────────────────────────

	/** Start the dev environment (containers + optional servers) */
	start(options?: StartOptions): Promise<DevServerPids | null>;
	/** Stop the dev environment */
	stop(options?: StopOptions): Promise<void>;
	/** Restart containers only */
	restart(): Promise<void>;
	/** Check if containers are running */
	isRunning(): Promise<boolean>;

	// ─────────────────────────────────────────────────────────────────────────
	// Server Management
	// ─────────────────────────────────────────────────────────────────────────

	/** Start dev servers only (assumes containers are running) */
	startServers(options?: {
		productionBuild?: boolean;
		verbose?: boolean;
	}): Promise<DevServerPids>;
	/** Stop a process by PID */
	stopProcess(pid: number): void;
	/** Wait for servers to be ready */
	waitForServers(options?: {
		timeout?: number;
		productionBuild?: boolean;
	}): Promise<void>;

	// ─────────────────────────────────────────────────────────────────────────
	// Utilities
	// ─────────────────────────────────────────────────────────────────────────

	/** Build environment variables for shell commands */
	buildEnvVars(production?: boolean): Record<string, string>;
	/** Execute a command with environment variables set */
	exec(
		cmd: string,
		options?: ExecOptions,
	): Promise<{ exitCode: number; stdout: string; stderr: string }>;
	/** Wait for an HTTP server to respond */
	waitForServer(url: string, timeout?: number): Promise<void>;
	/** Log environment info to console */
	logInfo(label?: string): void;

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
	withSuffix(suffix: string): DevEnvironment<TServices, TApps>;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI Options
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for the CLI runner.
 */
export interface CliOptions {
	/** Custom args (defaults to process.argv.slice(2)) */
	args?: string[];
	/** Enable watchdog auto-shutdown (default: true) */
	watchdog?: boolean;
	/** Watchdog timeout in minutes (default: 10) */
	watchdogTimeout?: number;
	/** Command to run dev servers (e.g., 'bun concurrently ...') */
	devServersCommand?: string;
}
