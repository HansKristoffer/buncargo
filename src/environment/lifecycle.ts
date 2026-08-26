import { toPortMap } from "../core/ports";
import { isCI } from "../core/runtime-flags";
import { formatDone, formatStep } from "../core/style";
import {
	areServicesRunning,
	ensureServicesRunning,
	stopContainers,
} from "../docker";
import { buildStartPlan, resolveComposeServiceNames } from "../planning";
import type {
	AppConfig,
	DevServerPids,
	EnvValues,
	MigrationConfig,
	SeedOutcome,
	SeedRunOptions,
	ServiceConfig,
	StartOptions,
	StopOptions,
} from "../types";
import type { DevEnvContext } from "./context";
import type { DevEnvVarsApi } from "./env-vars";
import { runMigrationsSequentially } from "./migrations";
import { runSeedIfNeeded } from "./seeding";
import { startAppServers } from "./servers";

export interface DevLifecycleApi<
	TApps extends Record<string, AppConfig> = Record<string, AppConfig>,
> {
	start(options?: StartOptions<TApps>): Promise<DevServerPids | null>;
	stop(options?: StopOptions): Promise<void>;
	restart(): Promise<void>;
	isRunning(): Promise<boolean>;
	runSeed(options?: SeedRunOptions): Promise<SeedOutcome>;
}

export function createLifecycleApi<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues = EnvValues,
>(
	ctx: DevEnvContext<TServices, TApps, TEnv>,
	envVars: DevEnvVarsApi<TServices, TApps, TEnv>,
): DevLifecycleApi<TApps> {
	const { config, services, apps, ports } = ctx;

	function collectMigrations(): MigrationConfig[] {
		return [
			...(config.prisma
				? [
						{
							name: "prisma",
							command: "bunx prisma migrate deploy",
							cwd: config.prisma.cwd ?? "packages/prisma",
						},
					]
				: []),
			...(config.migrations ?? []),
		];
	}

	async function runPrepareSteps(verbose: boolean): Promise<void> {
		const migrations = collectMigrations();
		if (migrations.length > 0) {
			if (verbose) console.log(formatStep("📦 Running migrations..."));
			await runMigrationsSequentially(migrations, envVars.exec);
			if (verbose) console.log(formatDone("Migrations complete"));
		}

		if (config.prisma?.generate) {
			if (verbose) console.log(formatStep("📦 Generating Prisma client..."));
			await envVars.exec(config.prisma.generate, {
				cwd: config.prisma.cwd ?? "packages/prisma",
				verbose,
			});
			if (verbose) console.log(formatDone("Prisma generate complete"));
		}
	}

	function runSeed(options: SeedRunOptions = {}): Promise<SeedOutcome> {
		return runSeedIfNeeded(ctx, envVars, options);
	}

	async function start(
		startOptions: StartOptions<TApps> = {},
	): Promise<DevServerPids | null> {
		const ci = isCI();
		const {
			verbose = config.options?.verbose ?? true,
			wait = true,
			startServers: shouldStartServers = true,
			productionBuild = ci,
			skipSeed = false,
			skipEnvironmentLog = false,
			onlyApps,
			autoStartDocker = config.docker?.autoStart,
		} = startOptions;

		const startPlan = buildStartPlan(apps, services, onlyApps);
		const appsToStart = startPlan.apps;
		const targetServices: Record<string, ServiceConfig> = Object.fromEntries(
			startPlan.requiredServiceKeys.map(
				(serviceKey) => [serviceKey, services[serviceKey]] as const,
			),
		);
		const portMap = toPortMap(ports);
		const targetPorts = Object.fromEntries(
			startPlan.requiredServiceKeys.map(
				(serviceKey) => [serviceKey, portMap[serviceKey]] as const,
			),
		);
		let containersReady = false;

		ctx.ensureComposeFile();

		if (verbose && !skipEnvironmentLog) {
			ctx.logInfo(
				productionBuild ? "Production Environment" : "Dev Environment",
			);
		}

		await ensureServicesRunning(
			ctx.root,
			ctx.projectName,
			envVars.buildEnvVars(productionBuild),
			targetServices,
			targetPorts,
			{ verbose, wait, composeFile: ctx.composeFile, autoStartDocker },
		);
		containersReady = true;

		try {
			await runPrepareSteps(verbose);

			if (config.hooks?.afterContainersReady) {
				await config.hooks.afterContainersReady(envVars.getHookContext());
			}

			if (!skipSeed) {
				const seeded = await runSeed({ verbose, productionBuild });
				if (seeded.status === "failed") {
					throw new Error(
						`Seeding failed with exit code ${seeded.result.exitCode}. Fix the seed command or start with \`--up-only\` to skip it.`,
					);
				}
			}

			if (shouldStartServers && Object.keys(appsToStart).length > 0) {
				if (config.hooks?.beforeServers) {
					await config.hooks.beforeServers(envVars.getHookContext());
				}

				const pids = await startAppServers(ctx, envVars, {
					apps: appsToStart,
					productionBuild,
					verbose,
				});

				if (config.hooks?.afterServers) {
					await config.hooks.afterServers(envVars.getHookContext());
				}

				if (verbose) console.log(formatDone("Environment ready"));
				return pids;
			}

			return null;
		} catch (error) {
			if (containersReady) {
				console.error(
					formatStep(
						"ℹ Containers are still running. Use `bunx buncargo dev --down` to stop them.",
					),
				);
			}
			throw error;
		}
	}

	async function stop(stopOptions: StopOptions = {}): Promise<void> {
		const { verbose = true, removeVolumes = false } = stopOptions;
		ctx.ensureComposeFile();

		if (config.hooks?.beforeStop) {
			await config.hooks.beforeStop(envVars.getHookContext());
		}

		stopContainers(ctx.root, ctx.projectName, {
			verbose,
			removeVolumes,
			composeFile: ctx.composeFile,
		});
	}

	async function restart(): Promise<void> {
		await stop();
		await start({ startServers: false });
	}

	async function isRunning(): Promise<boolean> {
		return areServicesRunning(
			ctx.projectName,
			resolveComposeServiceNames(services, Object.keys(services)),
		);
	}

	return { start, stop, restart, isRunning, runSeed };
}
