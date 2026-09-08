import { relative } from "node:path";
import { ensureServicesRunning } from "../container-runtime";
import { withDeadline } from "../core/deadline";
import { toPortMap, toUrlMap } from "../core/ports";
import { stopDevServers } from "../core/process/dev-servers";
import { isCI } from "../core/runtime-flags";
import { formatDone, formatStep, formatWarn } from "../core/style";
import {
	createHeartbeatOwner,
	withWatchdogProjectLock,
} from "../core/watchdog";
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
import { assertAppWorkingDirectories, startAppServers } from "./servers";

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

	let selectedServices: string[] = [];
	let selectedApps: string[] = [];
	let started = false;

	function preparationSelected(prerequisites?: readonly string[]): boolean {
		// Omitted prerequisites preserve legacy container-backed preparation;
		// an explicit empty list opts into preparation for app-only selections.
		return prerequisites
			? prerequisites.every((name) => selectedServices.includes(name))
			: selectedServices.length > 0;
	}

	function appOnlyRun(): boolean {
		return (
			(started && selectedServices.length === 0) ||
			Object.keys(services).length === 0
		);
	}

	function currentSelection() {
		return { appNames: selectedApps, requiredServiceKeys: selectedServices };
	}

	function hookContext(signal?: AbortSignal) {
		return envVars.getHookContext(signal, currentSelection());
	}

	function prismaSelected(): boolean {
		return selectedServices.includes(config.prisma?.service ?? "postgres");
	}

	function collectMigrations(): MigrationConfig[] {
		const migrations: MigrationConfig[] = [];

		if (config.prisma && prismaSelected()) {
			migrations.push({
				name: "prisma",
				command: "bunx --no-install prisma migrate deploy",
				cwd: config.prisma.cwd ?? "packages/prisma",
			});
		}

		return migrations.concat(
			(config.migrations ?? []).filter((entry) =>
				preparationSelected(entry.requiredServices),
			),
		);
	}

	async function runPrepareSteps(
		verbose: boolean,
		signal?: AbortSignal,
		onPhase?: (name: string, ms: number) => void,
		generate = true,
	): Promise<void> {
		const execute: typeof envVars.exec = (cmd, options) =>
			envVars.exec(cmd, {
				...options,
				signal,
				timeoutMs: options?.timeoutMs ?? 600000,
			});
		const migrations = collectMigrations();
		const beforeMigrations = config.hooks?.beforeMigrations;
		if (
			beforeMigrations &&
			(config.prisma ? prismaSelected() : selectedServices.length > 0)
		) {
			await withDeadline(
				(hookSignal) => beforeMigrations(hookContext(hookSignal)),
				600000,
				signal,
			);
		}

		if (migrations.length > 0) {
			if (verbose) {
				console.log(formatStep("📦 Running migrations..."));
			}

			const began = performance.now();
			try {
				await runMigrationsSequentially(migrations, execute);
			} finally {
				onPhase?.("migrations", performance.now() - began);
			}

			if (verbose) {
				console.log(formatDone("Migrations complete"));
			}
		}

		const generateCheck = config.prisma?.generateCheck;
		if (
			generate &&
			prismaSelected() &&
			config.prisma?.generate &&
			(!generateCheck ||
				(await withDeadline(
					async (hookSignal) => generateCheck(hookContext(hookSignal)),
					600_000,
					signal,
				)))
		) {
			if (verbose) {
				console.log(formatStep("📦 Generating Prisma client..."));
			}

			const began = performance.now();
			try {
				await execute(config.prisma.generate, {
					cwd: config.prisma.cwd ?? "packages/prisma",
					verbose,
				});
			} finally {
				onPhase?.("generation", performance.now() - began);
			}

			if (verbose) {
				console.log(formatDone("Prisma generate complete"));
			}
		}
	}

	function runSeed(options: SeedRunOptions = {}): Promise<SeedOutcome> {
		if (started && !preparationSelected(config.seed?.requiredServices)) {
			return Promise.resolve({ status: "not-needed" });
		}

		return runSeedIfNeeded(
			ctx,
			envVars,
			options,
			started ? currentSelection() : undefined,
		);
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
		if (!verbose || !result) {
			return;
		}

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
		const { signal, onPhase, prepare = "all" } = startOptions;
		signal?.throwIfAborted();

		async function phase<T>(name: string, work: () => Promise<T>): Promise<T> {
			const began = performance.now();
			try {
				signal?.throwIfAborted();
				return await work();
			} finally {
				onPhase?.(name, performance.now() - began);
			}
		}

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
		if (shouldStartServers && prepare === "all") {
			assertAppWorkingDirectories(appsToStart, ctx.root, productionBuild);
		}

		const targetServices: Record<string, ServiceConfig> = Object.fromEntries(
			startPlan.requiredServiceKeys.map(
				(serviceKey) => [serviceKey, services[serviceKey]] as const,
			),
		);
		ctx.prepareStart?.(onlyApps);
		selectedServices = startPlan.requiredServiceKeys;
		selectedApps = startPlan.appNames;
		started = true;

		const hasServices = selectedServices.length > 0;
		const portMap = toPortMap(ports);
		const targetPorts: Record<string, number> = {};
		for (const serviceKey of selectedServices) {
			for (const name of [serviceKey, `${serviceKey}Secondary`]) {
				const port = portMap[name];
				if (port !== undefined) {
					targetPorts[name] = port;
				}
			}
		}

		const startupHeartbeat = createHeartbeatOwner(ctx.projectName, ctx.root);
		if (hasServices) {
			startupHeartbeat.start();
		}

		try {
			if (verbose && !skipEnvironmentLog) {
				ctx.logInfo(
					productionBuild ? "Production Environment" : "Dev Environment",
				);
			}

			// Containers-only mode bypasses preparation and starts every selected service.
			const earlyServices = Object.fromEntries(
				Object.entries(targetServices).filter(
					([, service]) =>
						prepare === "containers" || !service.afterPreparation,
				),
			);
			const lateServices = Object.fromEntries(
				Object.entries(targetServices).filter(
					([, service]) => service.afterPreparation,
				),
			);

			// Both subsets must fingerprint the same Compose artifact.
			let artifactReady = false;

			async function ensureSubset(
				subset: Record<string, ServiceConfig>,
				noDeps = false,
			) {
				if (Object.keys(subset).length === 0) {
					return;
				}

				await phase("containers", () =>
					withWatchdogProjectLock(
						ctx.projectName,
						ctx.root,
						() => {
							if (!artifactReady) {
								ctx.ensureComposeFile();
								artifactReady = true;
							}

							return ensureServicesRunning({
								signal,
								runtime: ctx.runtime,
								root: ctx.root,
								projectName: ctx.projectName,
								envVars: envVars.buildEnvVars(productionBuild),
								services: subset,
								noDeps,
								ports: targetPorts,
								model: ctx.composeModel(),
								composeFile: ctx.composeFile,
								verbose,
								wait,
								autoStartRuntime: autoStartDocker,
							});
						},
						signal,
					),
				);
			}

			if (hasServices) {
				await ensureSubset(earlyServices);
			}

			// Before migrations, not just before servers: Prisma and friends read
			// `.env` off disk themselves, so a stale port fails the migrate step.
			await phase("dotenv", () => syncConfiguredEnvFile(verbose));
			if (prepare === "containers") {
				return null;
			}

			try {
				await runPrepareSteps(verbose, signal, onPhase, prepare !== "migrate");
				if (prepare === "migrate") {
					return null;
				}

				const afterContainersReady = config.hooks?.afterContainersReady;
				if (afterContainersReady && hasServices) {
					await phase("container hooks", () =>
						withDeadline(
							(hookSignal) => afterContainersReady(hookContext(hookSignal)),
							600_000,
							signal,
						),
					);
				}

				if (!skipSeed && preparationSelected(config.seed?.requiredServices)) {
					const seeded = await phase("seed", () =>
						runSeed({ verbose, productionBuild, signal }),
					);
					if (seeded.status === "failed") {
						throw new Error(
							`Seeding failed with exit code ${seeded.result.exitCode}. Fix the seed command or start with \`--up-only\` to skip it.`,
						);
					}
				}

				// Early jobs already completed. --no-deps prevents Compose from rerunning them.
				await ensureSubset(lateServices, true);

				if (shouldStartServers && Object.keys(appsToStart).length > 0) {
					const pids = await startAppServers(ctx, envVars, {
						signal,
						apps: appsToStart,
						productionBuild,
						verbose,
					});

					if (verbose) {
						console.log(formatDone("Environment ready"));
					}

					return pids;
				}

				return null;
			} catch (error) {
				if (hasServices) {
					console.error(
						formatStep(
							"ℹ Containers are still running. Use `bunx buncargo dev --down` to stop them.",
						),
					);
				}
				throw error;
			}
		} finally {
			startupHeartbeat.stop();
		}
	}

	async function stop(stopOptions: StopOptions = {}): Promise<void> {
		const { verbose = true, removeVolumes = false } = stopOptions;
		stopOptions.signal?.throwIfAborted();
		const beforeStop = config.hooks?.beforeStop;
		if (beforeStop) {
			await withDeadline(
				(hookSignal) => beforeStop(hookContext(hookSignal)),
				600000,
				stopOptions.signal,
			);
		}

		await stopDevServers(ctx.ownedServerPids ?? {});
		if (appOnlyRun()) {
			return;
		}

		await withWatchdogProjectLock(
			ctx.projectName,
			ctx.root,
			async () => {
				ctx.ensureComposeFile();
				await (
					ctx.runtime.downAsync?.bind(ctx.runtime) ??
					ctx.runtime.down.bind(ctx.runtime)
				)({
					root: ctx.root,
					projectName: ctx.projectName,
					model: ctx.composeModel(),
					composeFile: ctx.composeFile,
					verbose,
					removeVolumes,
					signal: stopOptions.signal,
				});
			},
			stopOptions.signal,
		);
	}

	async function restart(): Promise<void> {
		await stop();
		await start({ startServers: false });
	}

	async function isRunning(): Promise<boolean> {
		if (appOnlyRun()) {
			return false;
		}

		return ctx.runtime.areServicesRunning(
			ctx.projectName,
			resolveComposeServiceNames(services, Object.keys(services)),
		);
	}

	return { start, stop, restart, isRunning, runSeed };
}
