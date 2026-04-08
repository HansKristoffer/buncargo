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
import { join } from "node:path";
import { ensureServicesRunning } from "../docker/runtime";
import { getComposeServiceName } from "../planning";
import type {
	AppConfig,
	BuiltInHealthCheck,
	DevEnvironment,
	PrismaConfig,
	PrismaRunner,
	ServiceConfig,
} from "../types";

/**
 * Create a Prisma runner from config (used internally by createDevEnvironment).
 * @internal
 */
export function createPrismaRunner<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(env: DevEnvironment<TServices, TApps>, config: PrismaConfig): PrismaRunner {
	const {
		cwd = "packages/prisma",
		service = "postgres",
		urlEnvVar = "DATABASE_URL",
	} = config;

	// Map service names to health check types
	const healthCheckTypes: Record<string, BuiltInHealthCheck> = {
		postgres: "pg_isready",
		redis: "redis-cli",
		clickhouse: "http",
	};

	function getDatabaseUrl(): string {
		const envVars = env.buildEnvVars();
		const url = envVars[urlEnvVar];
		if (!url) {
			throw new Error(
				`Environment variable ${urlEnvVar} not found. Make sure your dev config defines it in envVars.`,
			);
		}
		return url;
	}

	async function ensureDatabase(): Promise<void> {
		const composeFile = env.ensureComposeFile();
		const envVars = env.buildEnvVars();
		const serviceConfig = (env.services as Record<string, ServiceConfig>)[
			service
		];
		if (!serviceConfig) {
			throw new Error(`Prisma service "${service}" is not configured`);
		}

		const port = (env.ports as Record<string, number>)[service];
		if (!port) {
			throw new Error(`Service ${service} not found in dev environment ports`);
		}

		const healthCheckType = healthCheckTypes[service] ?? "tcp";
		const healthCheckedServiceConfig: ServiceConfig = {
			...serviceConfig,
			healthCheck: serviceConfig.healthCheck ?? healthCheckType,
			serviceName: getComposeServiceName(
				env.services as Record<string, ServiceConfig>,
				service,
			),
		};

		await ensureServicesRunning(
			env.root,
			env.projectName,
			envVars,
			{ [service]: healthCheckedServiceConfig },
			{ [service]: port },
			{
				verbose: true,
				wait: true,
				composeFile,
			},
		);
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
`);
			return 0;
		}

		const port = (env.ports as Record<string, number>)[service];

		console.log(`
🔧 Prisma CLI
   Project: ${env.projectName}
   Database: localhost:${port}
   ${env.portOffset > 0 ? `(port offset +${env.portOffset})` : ""}
`);

		await ensureDatabase();

		const envVars = env.buildEnvVars();
		const workingDir = join(env.root, cwd);
		const fullEnv = {
			...process.env,
			...envVars,
			[urlEnvVar]: getDatabaseUrl(),
		};

		console.log(`🔄 Running: prisma ${args.join(" ")}\n`);

		return new Promise((resolve) => {
			const proc = spawn("bunx", ["prisma", ...args], {
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

	return { run, getDatabaseUrl, ensureDatabase };
}
