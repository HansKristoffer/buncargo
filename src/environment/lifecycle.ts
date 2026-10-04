import { join, relative } from "node:path";
import {
	ensureServicesRunning,
	withProjectLifecycleLock,
} from "../container-runtime";
import { registerAbortCleanup, withDeadline } from "../core/deadline";
import { toPortMap, toUrlMap } from "../core/ports";
import { stopDevServers } from "../core/process/dev-servers";
import { isCI } from "../core/runtime-flags";
import { formatDone, formatStep, formatWarn } from "../core/style";
import { resolveComposeServiceNames } from "../planning";
import { appliedMigrationCount } from "../prisma/migrations-applied";
import { recordGeneratedPrismaHash } from "../prisma/schema-hash";
import type {
	AnyDevConfig,
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
import { renderGeneratedFiles } from "./generated-files";
import { LifecycleCoordinator } from "./lifecycle-coordinator";
import { runMigrationsSequentially } from "./migrations";
import { prefetchSecrets } from "./prefetch-secrets";
import type { DevRunClaimApi } from "./run-claim";
import { assertSeedSucceeded, seedCanOverlap } from "./seed-startup";
import { runSeedIfNeeded } from "./seeding";
import { assertAppWorkingDirectories, startAppServers } from "./servers";
import {
	composeServicesOf,
	configuredStacks,
	stacksForServices,
} from "./stacks";

export interface DevLifecycleApi<
	TApps extends Record<string, AppConfig> = Record<string, AppConfig>,
	TServices extends Record<string, ServiceConfig> = Record<
		string,
		ServiceConfig
	>,
> {
	start(
		options?: StartOptions<TApps, TServices>,
	): Promise<DevServerPids | null>;
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
	runClaim: DevRunClaimApi,
	coordinator = new LifecycleCoordinator(),
): DevLifecycleApi<TApps, TServices> {
	const { config, services, ports } = ctx;

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
				await runMigrationsSequentially(
					migrations,
					execute,
					async (migration) => {
						if (
							migration !== migrations[0] ||
							!config.prisma ||
							!prismaSelected()
						)
							return false;
						const serviceKey = config.prisma.service ?? "postgres";
						const service = services[serviceKey];
						const url = toUrlMap(ctx.loopbackUrls)[serviceKey];
						// An overlay may target a different database; never skip that deploy
						// based on the state of our local service.
						const computed: Record<string, string> = envVars.buildEnvVars();
						if (
							!service ||
							computed[config.prisma.urlEnvVar ?? "DATABASE_URL"] !== url
						)
							return false;
						const count = await appliedMigrationCount({
							root: ctx.root,
							prisma: config.prisma,
							serviceKey,
							service,
							url,
							signal,
						});
						if (count === undefined) return false;
						if (verbose)
							console.log(formatDone(`Migrations up to date (${count})`));
						return true;
					},
				);
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
				const prismaCwd = config.prisma.cwd ?? "packages/prisma";
				await execute(config.prisma.generate, { cwd: prismaCwd, verbose });
				recordGeneratedPrismaHash(ctx.root, join(ctx.root, prismaCwd));
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

	function start(
		startOptions: StartOptions<TApps, TServices> = {},
	): Promise<DevServerPids | null> {
		return coordinator.start(
			(signal) =>
				startEnvironment({
					...startOptions,
					signal: startOptions.signal
						? AbortSignal.any([signal, startOptions.signal])
						: signal,
				}),
			startOptions.signal,
			(pids) => pids !== null && Object.keys(pids).length > 0,
		);
	}

	async function startEnvironment(
		startOptions: StartOptions<TApps, TServices> = {},
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
			onlyServices,
			autoStartDocker = config.docker?.autoStart,
		} = startOptions;

		const startPlan = ctx.getStartPlan(onlyApps, onlyServices);
		const appsToStart = startPlan.apps;
		if (shouldStartServers && prepare === "all") {
			assertAppWorkingDirectories(appsToStart, ctx.root, productionBuild);
		}

		const targetServices: Record<string, ServiceConfig> = Object.fromEntries(
			startPlan.requiredServiceKeys.map(
				(serviceKey) => [serviceKey, services[serviceKey]] as const,
			),
		);
		await ctx.prepareStartAsync(onlyApps, onlyServices, signal);
		selectedServices = startPlan.requiredServiceKeys;
		selectedApps = startPlan.appNames;
		started = true;

		ctx.onSecretsWait = (ms) => onPhase?.("secrets", ms);
		const prefetchController = new AbortController();
		const prefetchSignal = signal
			? AbortSignal.any([signal, prefetchController.signal])
			: prefetchController.signal;
		const prefetches =
			prepare === "containers"
				? []
				: prefetchSecrets({
						apps: prepare === "all" ? appsToStart : {},
						defaults: config.secrets,
						seed: config.seed?.secrets,
						includeSeed:
							prepare === "all" &&
							(!skipSeed || startOptions.prefetchSeed === true) &&
							!!config.seed &&
							preparationSelected(config.seed.requiredServices),
						migrations: collectMigrations(),
						signal: prefetchSignal,
					});
		if (signal) registerAbortCleanup(signal, Promise.allSettled(prefetches));
		try {
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

			// Claimed before anything is created, so the sweep never sees a fresh
			// container as unowned. Idempotent, so a CLI that already claimed with
			// its own flags keeps those. The claim outlives `start()`: it is
			// retired by `stop()`, or released when this process exits.
			if (hasServices) {
				await runClaim.claimRun({ signal });
				// A script that starts containers and then crashes needs someone to
				// clean up after it, exactly as a `buncargo dev` does. Not awaited:
				// confirming the watchdog came up is no reason to delay the start.
				if (startOptions.watchdog !== false)
					void runClaim.ensureWatchdog().catch(() => {});
			}

			if (verbose && !skipEnvironmentLog) {
				ctx.logInfo(
					productionBuild ? "Production Environment" : "Dev Environment",
					undefined,
					currentSelection(),
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
				// Stacks start themselves, beside Compose rather than after it.
				const compose = composeServicesOf(subset);
				const stacks = stacksForServices(
					config as AnyDevConfig,
					Object.keys(subset),
				);
				if (Object.keys(compose).length === 0 && stacks.length === 0) {
					return;
				}

				const composeUp = () =>
					withProjectLifecycleLock(
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
								services: compose,
								noDeps,
								ports: targetPorts,
								model: ctx.composeModel(),
								composeFile: ctx.composeFile,
								verbose,
								wait,
								autoStartRuntime: autoStartDocker,
							});
						},
						{ signal },
					);

				await phase("containers", () =>
					Promise.all([
						Object.keys(compose).length > 0 ? composeUp() : undefined,
						...stacks.map(({ stack }) =>
							withDeadline(
								(stackSignal) => stack.up(hookContext(stackSignal)),
								600_000,
								signal,
							),
						),
					]),
				);
			}

			if (hasServices) {
				await ensureSubset(earlyServices);
			}

			// Before migrations, not just before servers: Prisma and friends read
			// `.env` off disk themselves, so a stale port fails the migrate step.
			await phase("dotenv", () => syncConfiguredEnvFile(verbose));
			// Before anything reads them: values not known yet (a tunnel URL, a
			// capture) render as the file's placeholder and re-render later.
			for (const path of renderGeneratedFiles(ctx, envVars)) {
				if (verbose) console.log(formatDone(`Generated ${path}`));
			}
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

				const overlap =
					!skipSeed &&
					shouldStartServers &&
					Object.keys(appsToStart).length > 0 &&
					seedCanOverlap(config.seed, services, selectedServices);
				if (
					config.seed?.beforeApps === false &&
					Object.keys(lateServices).length > 0 &&
					verbose
				) {
					console.log(
						formatStep(
							"Seed will run before apps because selected services use afterPreparation.",
						),
					);
				}
				if (
					!overlap &&
					!skipSeed &&
					preparationSelected(config.seed?.requiredServices)
				) {
					assertSeedSucceeded(
						await phase("seed", () =>
							runSeed({ verbose, productionBuild, signal }),
						),
					);
				}

				// Early jobs already completed. --no-deps prevents Compose from rerunning them.
				await ensureSubset(lateServices, true);

				if (shouldStartServers && Object.keys(appsToStart).length > 0) {
					const pids = await startAppServers(ctx, envVars, {
						signal,
						apps: appsToStart,
						onPhase,
						productionBuild,
						verbose,
						seed: overlap
							? (seedSignal) =>
									phase("seed", () =>
										runSeed({
											verbose,
											productionBuild,
											signal: seedSignal,
											prefixOutput: true,
										}),
									)
							: undefined,
						onSeedReady: () => {
							if (verbose) console.log(formatDone("All servers ready"));
						},
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
							"ℹ Containers are still running. Use `bunx buncargo dev --down` to stop them now.",
						),
					);
				}
				throw error;
			}
		} catch (error) {
			prefetchController.abort(error);
			await Promise.allSettled(prefetches);
			throw error;
		}
	}

	function stop(stopOptions: StopOptions = {}): Promise<void> {
		return coordinator.stop(
			() => stopEnvironment(stopOptions),
			stopOptions.signal,
		);
	}

	async function stopEnvironment(stopOptions: StopOptions = {}): Promise<void> {
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
		for (const name of Object.keys(ctx.ownedServerPids ?? {}))
			delete ctx.ownedServerPids?.[name];
		if (appOnlyRun()) {
			return;
		}

		if (Object.keys(composeServicesOf(services)).length > 0) {
			await withProjectLifecycleLock(
				ctx.projectName,
				ctx.root,
				async () => {
					ctx.ensureComposeFile();
					await ctx.runtime.down({
						root: ctx.root,
						projectName: ctx.projectName,
						model: ctx.composeModel(),
						composeFile: ctx.composeFile,
						verbose,
						removeVolumes,
						signal: stopOptions.signal,
					});
				},
				{ signal: stopOptions.signal },
			);
		}

		// Every stack, not just this run's selection: stop means the environment.
		for (const { name, stack } of configuredStacks(config as AnyDevConfig)) {
			await envVars.exec(
				stack.down({
					projectName: ctx.projectName,
					root: ctx.root,
					removeVolumes,
				}),
				{ secrets: false, signal: stopOptions.signal, timeoutMs: 120_000 },
			);
			if (verbose) console.log(formatDone(`Stopped ${name}`));
		}
		await runClaim.retireRun();
	}

	function restart(): Promise<void> {
		return coordinator.restart(
			(signal) => stopEnvironment({ signal }),
			(signal) => startEnvironment({ startServers: false, signal }),
		);
	}

	async function isRunning(): Promise<boolean> {
		if (appOnlyRun()) {
			return false;
		}

		const compose = composeServicesOf(services);
		const names = resolveComposeServiceNames(compose, Object.keys(compose));
		if (names.length === 0) return false;
		const states = await ctx.runtime.projectServiceStates(ctx.projectName);
		const running = new Set(
			states.filter((state) => state.running).map((state) => state.service),
		);
		return names.every((name) => running.has(name));
	}

	return { start, stop, restart, isRunning, runSeed };
}
