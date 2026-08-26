import { relative } from "node:path";
import { ensureServicesRunning } from "../container-runtime";
import { toPortMap, toUrlMap } from "../core/ports";
import { isCI } from "../core/runtime-flags";
import { formatDone, formatStep, formatWarn } from "../core/style";
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
import { syncEnvFile } from "./env-file";
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

	/**
	 * Wired here rather than offered as a hook: `beforeServers` never fires on
	 * the CLI path, which calls `start({ startServers: false })`.
	 */
	async function syncConfiguredEnvFile(verbose: boolean): Promise<void> {
		const result = await syncEnvFile({
			root: ctx.root,
			envFile: config.options?.envFile,
			projectName: ctx.projectName,
			services,
			ports: toPortMap(ports),
			loopbackUrls: toUrlMap(ctx.loopbackUrls),
		});
		if (!verbose || !result) return;
		if (result.absent) {
			console.log(
				formatWarn(`No ${relative(ctx.root, result.path)} to sync; skipped`),
			);
			return;
		}
		if (result.created || result.changed.length > 0) {
			const what = result.created
				? "Created"
				: `Synced ${result.changed.length} value${result.changed.length === 1 ? "" : "s"} in`;
			console.log(formatDone(`${what} ${relative(ctx.root, result.path)}`));
		}
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

		await ensureServicesRunning({
			runtime: ctx.runtime,
			root: ctx.root,
			projectName: ctx.projectName,
			envVars: envVars.buildEnvVars(productionBuild),
			services: targetServices,
			ports: targetPorts,
			model: ctx.composeModel(),
			composeFile: ctx.composeFile,
			verbose,
			wait,
			autoStartRuntime: autoStartDocker,
		});
		containersReady = true;

		// Before migrations, not just before servers: Prisma and friends read
		// `.env` off disk themselves, so a stale port fails the migrate step.
		await syncConfiguredEnvFile(verbose);

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

		ctx.runtime.down({
			root: ctx.root,
			projectName: ctx.projectName,
			model: ctx.composeModel(),
			composeFile: ctx.composeFile,
			verbose,
			removeVolumes,
		});
	}

	async function restart(): Promise<void> {
		await stop();
		await start({ startServers: false });
	}

	async function isRunning(): Promise<boolean> {
		return ctx.runtime.areServicesRunning(
			ctx.projectName,
			resolveComposeServiceNames(services, Object.keys(services)),
		);
	}

	return { start, stop, restart, isRunning, runSeed };
}
