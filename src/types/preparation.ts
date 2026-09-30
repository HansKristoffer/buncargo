import type { AppConfig, SecretsScopeConfig } from "./app";
import type { ConfigEnvVarNames } from "./computed";
import type { DevEnvironment } from "./environment";
import type { ExecResult, HookContext } from "./hooks";
import type { ServiceConfig } from "./service";

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
	/** Migration directory relative to prisma.cwd. Default: prisma/migrations. */
	migrations?: string;
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
	/** Return true when generation is needed. Unset always runs generate. */
	generateCheck?(
		ctx: HookContext<TServices, TApps>,
	): boolean | Promise<boolean>;
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
	/**
	 * Fail when the migrations do not produce the schema: `prisma migrate diff
	 * --from-migrations … --to-schema … --exit-code`, against a shadow database
	 * created in the configured Postgres service. Returns Prisma's exit code:
	 * 0 in sync, 2 drifted, 1 error.
	 */
	migrateCheck(options?: PrismaMigrateCheckOptions): Promise<number>;
	/** `prisma.cwd`, relative to the root. */
	readonly cwd: string;
	/** `prisma.generate`, when configured. */
	readonly generateCommand?: string;
	/** Run `prisma.generate` (or `prisma generate`) and record the schema it saw. */
	generate(): Promise<number>;
}

/** Options for {@link PrismaRunner.migrateCheck}; paths relative to `prisma.cwd`. */
export interface PrismaMigrateCheckOptions {
	/** Default: prisma.migrations, then `prisma/migrations` */
	migrations?: string;
	/** Schema file or folder. Default: `prisma/schema.prisma` */
	schema?: string;
	/** Extra arguments appended to `prisma migrate diff`. */
	args?: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Migrations Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for a migration command to run after containers are ready.
 */
export interface MigrationConfig {
	/** Run only when all prerequisites are selected. Unset runs with any selected service. */
	requiredServices?: readonly string[];
	/** Display name for the migration (e.g., 'prisma', 'clickhouse') */
	name: string;
	/** Command to run the migration */
	command: string;
	/** Working directory relative to monorepo root */
	cwd?: string;
	/** Infisical scope for this command. Default: the config-level `secrets`. `false`: none. */
	secrets?: SecretsScopeConfig | false;
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
	requiredServices?: readonly Extract<keyof TServices, string>[];
	/** Seed before apps. Default true; false overlaps apps unless a selected service needs afterPreparation. */
	beforeApps?: boolean;
	/** Command to run the seeder */
	command: string;
	/** Working directory relative to monorepo root */
	cwd?: string;
	/** Infisical scope for the seeder. Default: the config-level `secrets`. `false`: none. */
	secrets?: SecretsScopeConfig | false;
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
	/** Prefix seed output when running alongside app logs. */
	prefixOutput?: boolean;
	signal?: AbortSignal;
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
