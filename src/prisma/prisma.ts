/**
 * Prisma integration for buncargo.
 *
 * When `prisma` is configured in defineDevConfig, `dev.prisma` becomes available
 * with methods to run prisma commands against the Docker development database.
 *
 * @example
 * ```typescript
 * // In dev.config.ts
 * const config = defineDevConfig({
 *   projectPrefix: 'myapp',
 *   services: { postgres: { port: 5432, healthCheck: 'pg_isready' } },
 *   prisma: { cwd: 'packages/prisma' }  // Enable prisma integration
 * })
 *
 * // Usage
 * await dev.prisma.run(['migrate', 'dev'])
 * await dev.prisma.ensureDatabase()
 * const url = dev.prisma.getDatabaseUrl()
 * ```
 *
 * @internal This module is used internally by createDevEnvironment.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
	containerRuntimeForEnv,
	ensureServicesRunning,
} from "../container-runtime";
import { agentAwareProcessEnv } from "../core/child-env";
import { toPortMap } from "../core/ports";
import { shellExitCode } from "../core/process/exec";
import { getComposeServiceName } from "../planning";
import type {
	AppConfig,
	DevEnvironment,
	EnvValues,
	PrismaConfig,
	PrismaMigrateCheckOptions,
	PrismaNewMigrationOptions,
	PrismaNewMigrationResult,
	PrismaRunner,
	PrismaRunOptions,
	ResolvedService,
	ServiceConfig,
} from "../types";
import { resolvePrismaConfig } from "./config";
import { describeDatabaseUrl, foreignDatabaseUrls } from "./foreign-urls";
import {
	listMigrationFolders,
	nextMigrationTimestamp,
	PRISMA_SQUASHED_CHAIN_EXIT,
} from "./migration-chain";
import { missingAppliedMigrations } from "./migrations-applied";
import { generatePrismaClient } from "./schema-hash";

/** The major version of the `prisma` package installed for `dir`, if any. */
export function installedPrismaMajor(dir: string): number | undefined {
	try {
		const manifest = createRequire(join(dir, "package.json")).resolve(
			"prisma/package.json",
		);
		const { version } = JSON.parse(readFileSync(manifest, "utf8"));
		const major = Number.parseInt(String(version), 10);
		return Number.isFinite(major) ? major : undefined;
	} catch {
		return undefined;
	}
}

/**
 * How `ensureDatabase` waits for the database service: its resolved
 * `healthCheck` (a preset's own, whatever the service is keyed), and an open
 * port for a custom container that declares none.
 */
export function databaseHealthCheck(
	service: ResolvedService,
): ResolvedService["healthCheck"] {
	return service.healthCheck === false && service.preset === undefined
		? "tcp"
		: service.healthCheck;
}

/**
 * What `args` would destroy, when they ask Prisma for a destructive action:
 * `migrate reset`, or `db push` with `--force-reset` or `--accept-data-loss`.
 */
export function destructivePrismaAction(
	args: readonly string[],
): string | undefined {
	const follows = (first: string, second: string) =>
		args.some((arg, index) => arg === first && args[index + 1] === second);
	if (follows("migrate", "reset"))
		return "prisma migrate reset drops the database and every row in it";
	const dataLossFlag = args.find(
		(arg) => arg === "--force-reset" || arg === "--accept-data-loss",
	);
	if (follows("db", "push") && dataLossFlag)
		return `prisma db push ${dataLossFlag} can drop tables and the rows in them`;
	return undefined;
}

/**
 * Create a Prisma runner from config (used internally by createDevEnvironment).
 * @internal
 */
export function createPrismaRunner<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues = EnvValues,
>(
	env: DevEnvironment<TServices, TApps, TEnv>,
	config: PrismaConfig<TServices, TApps>,
	/** The config-level Infisical secrets, beneath the computed env. */
	resolveSecrets: (
		computed: Record<string, string>,
	) => Promise<Record<string, string>>,
	/**
	 * Settle the checkout's port block before the database starts outside a
	 * run, as `start()` does: the context's ports until then are an unprobed
	 * preview, and may be another project's container's.
	 */
	allocate: (service: Extract<keyof TServices, string>) => Promise<void>,
): PrismaRunner {
	const resolved = resolvePrismaConfig(config);
	const { cwd, urlEnvVar, urlEnvVars } = resolved;
	// The defaults only exist on configs that actually declare a postgres
	// service; `validateConfig` rejects the rest, including disk-loaded configs
	// whose keys are only known as strings.
	const service = resolved.service as Extract<keyof TServices, string>;

	function getDatabaseUrl(): string {
		// `urlEnvVar` defaults to a name the config need not declare, so the lookup
		// is by dynamic name and the closed env record has to be widened for it.
		const envVars: Record<string, string> = env.buildEnvVars();
		const url = envVars[urlEnvVar];
		if (!url) {
			throw new Error(
				`Environment variable ${urlEnvVar} not found. Declare it via the matching service env output (for example service.postgres() -> DATABASE_URL) or set prisma.urlEnvVar to a configured shared env name.`,
			);
		}
		return url;
	}

	async function ensureDatabase(): Promise<void> {
		await allocate(service);
		const composeFile = env.ensureComposeFile();
		const envVars = env.buildEnvVars();
		const serviceConfig = env.services[service];
		if (serviceConfig?.port === undefined) {
			throw new Error(`Prisma service "${service}" is not configured`);
		}

		const port = toPortMap(env.ports)[service];
		if (!port) {
			throw new Error(`Service ${service} not found in dev environment ports`);
		}

		const healthCheckedServiceConfig: ResolvedService = {
			...serviceConfig,
			healthCheck: databaseHealthCheck(serviceConfig),
		};

		await ensureServicesRunning({
			runtime: containerRuntimeForEnv(env),
			root: env.root,
			projectName: env.projectName,
			projectPrefix: env.projectPrefix,
			envVars,
			services: { [service]: healthCheckedServiceConfig },
			ports: { [service]: port },
			model: env.composeModel(),
			composeFile,
			// Its progress would land in the stdout `buncargo prisma` keeps for Prisma.
			verbose: false,
			wait: true,
		});
	}

	/** The variables Prisma runs with, and the database URL they target. */
	async function prismaEnv(extraEnv: Readonly<Record<string, string>>) {
		const envVars: Record<string, string> = env.buildEnvVars();
		const target = extraEnv[urlEnvVar] ?? getDatabaseUrl();
		const pointed = Object.fromEntries(
			urlEnvVars.map((name) => [name, target]),
		);
		const inherited = { ...(await resolveSecrets(envVars)), ...process.env };
		// Only what buncargo did not set itself can point elsewhere.
		for (const name of [
			...Object.keys(envVars),
			...Object.keys(pointed),
			...Object.keys(extraEnv),
		])
			delete inherited[name];
		return {
			target,
			foreign: foreignDatabaseUrls(inherited, target),
			// Not `unsetEnv`: Prisma's agent guard reads those variables.
			vars: agentAwareProcessEnv({
				...inherited,
				...envVars,
				...pointed,
				...extraEnv,
			}),
		};
	}

	/**
	 * Spawn the Prisma CLI in `prisma.cwd`, with the database URL set. Warns
	 * about inherited URLs to another server, and refuses a destructive
	 * command while one is set: Prisma may read it rather than ours.
	 */
	async function spawnPrisma(
		args: readonly string[],
		options: {
			env?: Readonly<Record<string, string>>;
			captureStdout?: boolean;
		} = {},
	): Promise<{ exitCode: number; stdout: string }> {
		const { vars, foreign, target } = await prismaEnv(options.env ?? {});
		for (const { name, server } of foreign)
			console.error(
				`⚠️  ${name} points at ${server}, not this checkout's database (${describeDatabaseUrl(target)}). Prisma uses it if prisma.config.ts reads it: unset it, or add it to prisma.urlEnvVar.`,
			);
		const destructive = destructivePrismaAction(args);
		if (destructive && foreign.length > 0) {
			console.error(
				`❌ ${destructive}. Refusing while ${foreign.map((url) => url.name).join(", ")} point${foreign.length === 1 ? "s" : ""} at another server.`,
			);
			return { exitCode: 1, stdout: "" };
		}

		// stdout is Prisma's alone: `migrate diff --script > migration.sql`.
		console.error(`🔄 Running: prisma ${args.join(" ")}\n`);

		return new Promise((resolve) => {
			const proc = spawn("bunx", ["--no-install", "prisma", ...args], {
				cwd: join(env.root, cwd),
				env: vars,
				stdio: [
					"inherit",
					options.captureStdout ? "pipe" : "inherit",
					"inherit",
				],
			});
			const chunks: Buffer[] = [];
			proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));

			proc.on("close", (code, signal) => {
				resolve({
					exitCode: shellExitCode(code, signal),
					stdout: Buffer.concat(chunks).toString("utf8"),
				});
			});

			proc.on("error", (error) => {
				console.error(`❌ Failed to start Prisma CLI: ${error.message}`);
				resolve({ exitCode: 1, stdout: "" });
			});
		});
	}

	/**
	 * Stop before `migrate deploy`, `dev` or `status` meets a database that
	 * applied migrations the checkout no longer has: Prisma's own answer is a
	 * reset prompt, or a deploy that leaves the schema half-known.
	 */
	async function squashedChain(
		args: readonly string[],
		url: string,
	): Promise<boolean> {
		const migrate = args[0] === "migrate" ? args[1] : undefined;
		if (migrate !== "deploy" && migrate !== "dev" && migrate !== "status")
			return false;
		const missing = await missingAppliedMigrations(
			url,
			join(env.root, cwd, resolved.migrations),
		);
		if (!missing?.length) return false;
		console.error(
			`❌ ${describeDatabaseUrl(url)} applied ${missing.length} migration${missing.length === 1 ? "" : "s"} this checkout no longer has (${missing.join(", ")}): the chain was squashed or rewritten.`,
		);
		console.error(
			"   Only recreating the database gets past it, and that drops its data: bunx buncargo dev --reset --yes. Ask before running it.",
		);
		return true;
	}

	async function run(
		args: string[],
		options: PrismaRunOptions = {},
	): Promise<number> {
		if (args.length === 0) {
			console.log(`
Usage: bun prisma <command> [args...]

Examples:
  bun prisma migrate dev     # Create new migration
  bun prisma migrate deploy  # Apply migrations
  bun prisma db push         # Push schema changes
  bun prisma studio          # Open Prisma Studio
  bun prisma migrate reset   # Reset database
  bun prisma migrate-check   # Fail if migrations and schema differ
  bun prisma migration new <name>  # Write a migration, no terminal needed
  bun prisma migration check       # Fail on timestamps out of order with the base branch
  bun prisma --db=scratch_<name> <command>  # Against a scratch database
`);
			return 0;
		}

		await allocate(service);
		const target = options.env?.[urlEnvVar] ?? getDatabaseUrl();

		console.error(`
🔧 Prisma CLI
   Project: ${env.projectName}
   Database: ${describeDatabaseUrl(target)}
   ${env.portOffset > 0 ? `(port offset +${env.portOffset})` : ""}
`);

		await ensureDatabase();
		if (await squashedChain(args, target)) return PRISMA_SQUASHED_CHAIN_EXIT;
		return (await spawnPrisma(args, { env: options.env })).exitCode;
	}

	/**
	 * Create `database` beside the dev one, in the container, so no host
	 * `psql` is needed, and only when missing. Returns its URL.
	 */
	async function createServiceDatabase(
		database: string,
		purpose: string,
	): Promise<string> {
		const url = new URL(getDatabaseUrl());
		const user = decodeURIComponent(url.username) || "postgres";
		const created = await execInDatabaseService(
			// Positional parameters rather than interpolation: nothing is re-parsed.
			`psql -U "$1" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$2'" | grep -q 1 || createdb -U "$1" "$2"`,
			user,
			database,
		);
		if (!created) {
			throw new Error(
				`Could not create the database "${database}" in service "${service}". ${purpose} needs a Postgres service with psql and createdb.`,
			);
		}
		url.pathname = `/${database}`;
		return url.toString();
	}

	function execInDatabaseService(
		script: string,
		...params: string[]
	): Promise<boolean> {
		return containerRuntimeForEnv(env).execInService({
			projectName: env.projectName,
			serviceName: getComposeServiceName(env.services, service),
			root: env.root,
			timeoutMs: 30_000,
			command: ["sh", "-c", script, "sh", ...params],
		});
	}

	function devDatabaseName(): string {
		return (
			decodeURIComponent(new URL(getDatabaseUrl()).pathname.slice(1)) ||
			"postgres"
		);
	}

	/**
	 * `migrate diff` from `migrations` to `schema`, replaying the migrations
	 * into `shadowUrl`. Prisma 7 renamed `--to-schema-datamodel` and dropped
	 * `--shadow-database-url`: the shadow URL comes from prisma.config.ts,
	 * which reads it from the environment set here.
	 */
	function diffArgs(
		from: string[],
		schema: string,
		shadowUrl: string,
	): { args: string[]; modern: boolean } {
		const modern = (installedPrismaMajor(join(env.root, cwd)) ?? 7) >= 7;
		const shadow =
			!modern && from[0] === "--from-migrations"
				? ["--shadow-database-url", shadowUrl]
				: [];
		return {
			modern,
			args: [
				"migrate",
				"diff",
				...from,
				...(modern
					? ["--to-schema", schema]
					: ["--to-schema-datamodel", schema]),
				...shadow,
				"--exit-code",
			],
		};
	}

	const PRISMA_7_SHADOW_HINT =
		'   Prisma 7 reads the shadow database from prisma.config.ts: set datasource.shadowDatabaseUrl to env("SHADOW_DATABASE_URL").';

	async function migrateCheck(
		options: PrismaMigrateCheckOptions = {},
	): Promise<number> {
		await ensureDatabase();
		// Prisma resets it on every diff, so it must never be the dev database.
		const shadow = `${devDatabaseName()}_shadow`.replace(/[^A-Za-z0-9_]/g, "_");
		const shadowUrl = await createServiceDatabase(shadow, "migrate-check");

		const { args, modern } = diffArgs(
			["--from-migrations", options.migrations ?? resolved.migrations],
			options.schema ?? resolved.schema,
			shadowUrl,
		);
		const { exitCode: code } = await spawnPrisma(
			[...args, ...(options.args ?? [])],
			{ env: { SHADOW_DATABASE_URL: shadowUrl } },
		);

		if (code === 1 && modern) console.error(PRISMA_7_SHADOW_HINT);

		if (code === 0) console.error("✅ Migrations match the schema.");
		if (code === 2)
			console.error(
				"❌ The schema has changes no migration contains. Create one with `bunx buncargo prisma migration new <name>`.",
			);
		return code;
	}

	async function newMigration(
		name: string,
		options: PrismaNewMigrationOptions = {},
	): Promise<PrismaNewMigrationResult> {
		if (!/^[A-Za-z0-9_]{1,200}$/.test(name))
			throw new Error(
				`A migration name is letters, digits and _ (Prisma's folder names): got "${name}".`,
			);
		await ensureDatabase();
		const dir = join(env.root, cwd, resolved.migrations);
		const existing = await listMigrationFolders(dir);
		// Its own database, so a concurrent migrate-check's shadow is untouched.
		const scratch = `scratch_migration_new_${process.pid}`;
		const shadowUrl = await createServiceDatabase(scratch, "migration new");
		const { args, modern } = diffArgs(
			existing.length > 0
				? ["--from-migrations", resolved.migrations]
				: ["--from-empty"],
			resolved.schema,
			shadowUrl,
		);
		let diff: { exitCode: number; stdout: string };
		try {
			diff = await spawnPrisma([...args, "--script"], {
				env: { SHADOW_DATABASE_URL: shadowUrl },
				captureStdout: true,
			});
		} finally {
			// Best effort: Prisma resets a shadow database before replaying into
			// it, so one left behind does no harm.
			await execInDatabaseService(
				'dropdb -U "$1" --if-exists "$2"',
				decodeURIComponent(new URL(shadowUrl).username) || "postgres",
				scratch,
			).catch(() => false);
		}

		if (diff.exitCode === 1 && modern) console.error(PRISMA_7_SHADOW_HINT);
		if (diff.exitCode !== 0 && diff.exitCode !== 2)
			return { status: "failed", exitCode: diff.exitCode };
		if (diff.exitCode === 0 && !options.empty) return { status: "unchanged" };

		const folder = join(
			dir,
			`${nextMigrationTimestamp(existing, options.now ?? new Date())}_${name}`,
		);
		await mkdir(folder, { recursive: true });
		const sql = diff.exitCode === 2 ? diff.stdout : "";
		await writeFile(
			join(folder, "migration.sql"),
			sql.trim() === "" ? "-- This is an empty migration.\n" : sql,
		);
		const lock = join(dir, "migration_lock.toml");
		if (!existsSync(lock))
			await writeFile(
				lock,
				'# Please do not edit this file manually\n# It should be added in your version-control system (e.g., Git)\nprovider = "postgresql"\n',
			);
		return { status: "created", path: folder };
	}

	function generate(): Promise<number> {
		return generatePrismaClient(env.root, cwd, () =>
			env.exec(config.generate ?? "bunx --no-install prisma generate", {
				cwd,
				verbose: true,
				throwOnError: false,
			}),
		);
	}

	return {
		run,
		getDatabaseUrl,
		ensureDatabase,
		migrateCheck,
		newMigration,
		cwd,
		migrations: resolved.migrations,
		service,
		generateCommand: config.generate,
		generate,
	};
}
