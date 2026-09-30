import { toPortMap } from "../core/ports";
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
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
	containerRuntimeForEnv,
	ensureServicesRunning,
} from "../container-runtime";
import { getComposeServiceName } from "../planning";
import type {
	AppConfig,
	BuiltInHealthCheck,
	DevEnvironment,
	EnvValues,
	PrismaConfig,
	PrismaMigrateCheckOptions,
	PrismaRunner,
	ServiceConfig,
} from "../types";
import { recordGeneratedPrismaHash } from "./schema-hash";

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
): PrismaRunner {
	const { cwd = "packages/prisma" } = config;
	// The defaults only exist on configs that actually declare a postgres
	// service; `validateConfig` rejects the rest, including disk-loaded configs
	// whose keys are only known as strings.
	const service = (config.service ?? "postgres") as Extract<
		keyof TServices,
		string
	>;
	const urlEnvVar: string = config.urlEnvVar ?? "DATABASE_URL";

	// Map service names to health check types
	const healthCheckTypes: Record<string, BuiltInHealthCheck> = {
		postgres: "pg_isready",
		redis: "redis-cli",
		clickhouse: "http",
	};

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
		const composeFile = env.ensureComposeFile();
		const envVars = env.buildEnvVars();
		const serviceConfig = env.services[service];
		if (!serviceConfig || serviceConfig.kind === "job") {
			throw new Error(`Prisma service "${service}" is not configured`);
		}

		const port = toPortMap(env.ports)[service];
		if (!port) {
			throw new Error(`Service ${service} not found in dev environment ports`);
		}

		const healthCheckType = healthCheckTypes[service] ?? "tcp";
		const healthCheckedServiceConfig: ServiceConfig = {
			...serviceConfig,
			healthCheck: serviceConfig.healthCheck ?? healthCheckType,
			serviceName: getComposeServiceName(env.services, service),
		};

		await ensureServicesRunning({
			runtime: containerRuntimeForEnv(env),
			root: env.root,
			projectName: env.projectName,
			envVars,
			services: { [service]: healthCheckedServiceConfig },
			ports: { [service]: port },
			model: env.composeModel(),
			composeFile,
			verbose: true,
			wait: true,
		});
	}

	/** Spawn the Prisma CLI in `prisma.cwd`, with the database URL set. */
	async function spawnPrisma(
		args: readonly string[],
		extraEnv: Record<string, string> = {},
	): Promise<number> {
		const envVars: Record<string, string> = env.buildEnvVars();
		const workingDir = join(env.root, cwd);
		const fullEnv = {
			...(await resolveSecrets(envVars)),
			...process.env,
			...envVars,
			[urlEnvVar]: getDatabaseUrl(),
			...extraEnv,
		};

		console.log(`🔄 Running: prisma ${args.join(" ")}\n`);

		return new Promise((resolve) => {
			const proc = spawn("bunx", ["--no-install", "prisma", ...args], {
				cwd: workingDir,
				env: fullEnv,
				stdio: "inherit",
			});

			proc.on("close", (code) => {
				resolve(code ?? 0);
			});

			proc.on("error", (error) => {
				console.error(`❌ Failed to start Prisma CLI: ${error.message}`);
				resolve(1);
			});
		});
	}

	async function run(args: string[]): Promise<number> {
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
`);
			return 0;
		}

		const port = toPortMap(env.ports)[service];

		console.log(`
🔧 Prisma CLI
   Project: ${env.projectName}
   Database: localhost:${port}
   ${env.portOffset > 0 ? `(port offset +${env.portOffset})` : ""}
`);

		await ensureDatabase();
		return spawnPrisma(args);
	}

	/**
	 * A database beside the dev one for `migrate diff` to replay migrations
	 * into. Prisma resets it on every diff, so it must never be the dev
	 * database itself; created inside the container, so no host `psql` is
	 * needed, and only when missing.
	 */
	async function ensureShadowDatabase(): Promise<string> {
		const url = new URL(getDatabaseUrl());
		const database = decodeURIComponent(url.pathname.slice(1)) || "postgres";
		const shadow = `${database}_shadow`.replace(/[^A-Za-z0-9_]/g, "_");
		const user = decodeURIComponent(url.username) || "postgres";

		const created = await containerRuntimeForEnv(env).execInService({
			projectName: env.projectName,
			serviceName: getComposeServiceName(env.services, service),
			root: env.root,
			composeFile: env.composeFile,
			timeoutMs: 30_000,
			// Positional parameters rather than interpolation: nothing is re-parsed.
			command: [
				"sh",
				"-c",
				`psql -U "$1" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$2'" | grep -q 1 || createdb -U "$1" "$2"`,
				"sh",
				user,
				shadow,
			],
		});
		if (!created) {
			throw new Error(
				`Could not create the shadow database "${shadow}" in service "${service}". migrate-check needs a Postgres service with psql and createdb.`,
			);
		}

		url.pathname = `/${shadow}`;
		return url.toString();
	}

	async function migrateCheck(
		options: PrismaMigrateCheckOptions = {},
	): Promise<number> {
		await ensureDatabase();
		const shadowUrl = await ensureShadowDatabase();

		const schema = options.schema ?? "prisma/schema.prisma";
		// Prisma 7 renamed `--to-schema-datamodel` and dropped
		// `--shadow-database-url`: the shadow URL comes from prisma.config.ts,
		// which reads it from the environment set here.
		const modern = (installedPrismaMajor(join(env.root, cwd)) ?? 7) >= 7;
		const code = await spawnPrisma(
			[
				"migrate",
				"diff",
				"--from-migrations",
				options.migrations ?? config.migrations ?? "prisma/migrations",
				...(modern
					? ["--to-schema", schema]
					: [
							"--to-schema-datamodel",
							schema,
							"--shadow-database-url",
							shadowUrl,
						]),
				"--exit-code",
				...(options.args ?? []),
			],
			{ SHADOW_DATABASE_URL: shadowUrl },
		);

		if (code === 1 && modern)
			console.error(
				'   Prisma 7 reads the shadow database from prisma.config.ts: set datasource.shadowDatabaseUrl to env("SHADOW_DATABASE_URL").',
			);

		if (code === 0) console.log("✅ Migrations match the schema.");
		if (code === 2)
			console.error(
				"❌ The schema has changes no migration contains. Create one with `bunx buncargo prisma migrate dev`.",
			);
		return code;
	}

	async function generate(): Promise<number> {
		const result = await env.exec(
			config.generate ?? "bunx --no-install prisma generate",
			{ cwd, verbose: true, throwOnError: false },
		);
		if (result.exitCode === 0) {
			recordGeneratedPrismaHash(env.root, join(env.root, cwd));
		}
		return result.exitCode;
	}

	return {
		run,
		getDatabaseUrl,
		ensureDatabase,
		migrateCheck,
		cwd,
		generateCommand: config.generate,
		generate,
	};
}
