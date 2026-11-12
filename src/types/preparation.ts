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
	/**
	 * Schema file or folder relative to prisma.cwd, for `migrate-check` and
	 * `prisma migration new`. Default: prisma/schema.prisma.
	 */
	schema?: string;
	/** Configured service key for the database. Default: 'postgres' */
	service?: Extract<keyof TServices, string>;
	/**
	 * Environment variable name for the database URL. Default: 'DATABASE_URL'
	 *
	 * A list sets every name to the checkout's URL, for a `prisma.config.ts`
	 * that also reads a direct URL (`["DATABASE_URL", "DATABASE_URL_DIRECT"]`).
	 * The first is the one buncargo reads the URL from; the rest need not be
	 * declared.
	 *
	 * Deliberately not keyed on the `env` overlay: that would make `DevConfig`
	 * invariant in its overlay type, so a narrowly typed config could no longer
	 * be handed to anything expecting the widened one.
	 */
	urlEnvVar?:
		| ConfigEnvVarNames<TServices, TApps>
		| readonly [ConfigEnvVarNames<TServices, TApps>, ...string[]];
	/**
	 * Command to run after migrations (e.g. Prisma 7 `prisma generate --sql`).
	 * Skipped when unset.
	 */
	generate?: string;
	/**
	 * Whether generation is needed. `"schema-hash"` runs it only when the
	 * `.prisma` files changed since the last generate buncargo ran; a function
	 * returns true to run it. Unset always runs generate.
	 */
	generateCheck?:
		| "schema-hash"
		| ((ctx: HookContext<TServices, TApps>) => boolean | Promise<boolean>);
}

/**
 * Prisma runner interface available on dev.prisma when prisma is configured.
 */
export interface PrismaRunner {
	/**
	 * Run a prisma command with the correct environment. Returns exit code:
	 * Prisma's, 1 when a destructive command is refused because a variable
	 * points at another database server, or 4 when `migrate deploy`, `dev` or
	 * `status` would meet a database that applied migrations the checkout no
	 * longer has (a squashed chain: only a reset of the data gets past it).
	 */
	run(args: string[], options?: PrismaRunOptions): Promise<number>;
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
	/**
	 * Write a migration with what the schema has and the migrations lack, by
	 * `prisma migrate diff` against a database created for it and dropped
	 * after. Needs no terminal, unlike `migrate dev --create-only`.
	 */
	newMigration(
		name: string,
		options?: PrismaNewMigrationOptions,
	): Promise<PrismaNewMigrationResult>;
	/** `prisma.cwd`, relative to the root. */
	readonly cwd: string;
	/** `prisma.migrations`, relative to {@link cwd}. */
	readonly migrations: string;
	/** `prisma.service`: the database's service key. */
	readonly service: string;
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

/** Options for {@link PrismaRunner.run}. */
export interface PrismaRunOptions {
	/**
	 * Variables over the database's, last: `buncargo prisma --db` points the
	 * database URLs at another database of the same server with them.
	 */
	env?: Readonly<Record<string, string>>;
}

/** Options for {@link PrismaRunner.newMigration}. */
export interface PrismaNewMigrationOptions {
	/** Write an empty `migration.sql` when the schema has nothing new. */
	empty?: boolean;
	/** When the migration is created, for its folder's timestamp. Default: now. */
	now?: Date;
}

/** What {@link PrismaRunner.newMigration} did. */
export type PrismaNewMigrationResult =
	| { status: "created"; path: string }
	| { status: "unchanged" }
	| { status: "failed"; exitCode: number };

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
	/**
	 * Each line the seed command prints, instead of the terminal. The CLI feeds
	 * it to the run's output, so the seed reaches the TUI and the run's logs.
	 */
	onOutputLine?: (line: string) => void;
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
	| {
			status: "failed";
			result: ExecResult;
			/** The seed command, as configured. */
			command: string;
			/**
			 * Its last lines of output, in the order printed. Empty when it wrote
			 * straight to a terminal, where they are already on screen.
			 */
			tail: string[];
	  };
