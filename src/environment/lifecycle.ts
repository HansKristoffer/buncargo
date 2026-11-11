import { join, relative } from "node:path";
import { anySignal, startTimer } from "hanzio";
import {
	ensureServicesRunning,
	projectServiceStates,
	replaceStaleStacksOn,
	withProjectLifecycleLock,
} from "../container-runtime";
import { registerAbortCleanup, withDeadline } from "../core/deadline";
import { toPortMap, toUrlMap } from "../core/ports";
import { stopDevServers } from "../core/process/dev-servers";
import { isCI } from "../core/runtime-flags";
import { ensureSecretsSession } from "../core/secrets/index";
import { formatDone, formatStep, formatWarn } from "../core/style";
import { resolveComposeServiceNames } from "../planning";
import { resolvePrismaConfig } from "../prisma/config";
import {
	appliedMigrationCount,
	missingAppliedMigrations,
} from "../prisma/migrations-applied";
import { generatePrismaClient, prismaClientStale } from "../prisma/schema-hash";
import type {
	DevServerPids,
	MigrationConfig,
	ResolvedService,
	SeedOutcome,
	SeedRunOptions,
	ServicesStarted,
	StartOptions,
	StopOptions,
	WithServicesOptions,
} from "../types";
import { recordTeardown } from "./container-loss";
import type { DevEnvContext } from "./context";
import { syncEnvFile } from "./env-file";
import type { DevEnvVarsApi } from "./env-vars";
import {
	type GeneratedFilesContext,
	renderGeneratedFiles,
} from "./generated-files";
import type { LifecycleCoordinator } from "./lifecycle-coordinator";
import { runMigrationsSequentially } from "./migrations";
import type { AppPipeline, Prepared, PreparedSeed } from "./pipeline";
import { type PreparationPlan, planPreparation } from "./plan-preparation";
import { prefetchSecrets, startSecretScopes } from "./prefetch-secrets";
import type { DevRunClaimApi } from "./run-claim";
import { readRunsKeepingServices } from "./run-keep";
import { assertSeedSucceeded } from "./seed-startup";
import { runSeedIfNeeded, type SeedContext } from "./seeding";
import { assertAppWorkingDirectories } from "./servers";
import type { ServiceWatchApi } from "./service-watch";
import {
	composeServicesOf,
	configuredStacks,
	stacksForServices,
} from "./stacks";

/** `start()`'s options, plus what only `buncargo dev` and the commands set. */
export interface PrepareOptions extends StartOptions {
	/** Print the environment banner once the run is claimed. Default: false. */
	banner?: boolean;
}

export interface DevLifecycleApi {
	start(options?: StartOptions): Promise<DevServerPids | null>;
	/**
	 * Containers, dotenv, generated files, migrations, generation and the
	 * seed for a selection, the run claimed before the first container.
	 * What `start()` does before it spawns; `buncargo dev` spawns itself.
	 */
	prepare(options?: PrepareOptions): Promise<Prepared>;
	/**
	 * The Infisical session `prepare()` with these options needs, checked
	 * now: `buncargo dev` fires it before its checks and named hosts, and
	 * `prepare()` then reuses the token.
	 */
	secretsSession(options: PrepareOptions): Promise<void>;
	stop(options?: StopOptions): Promise<void>;
	withServices<T>(
		services: readonly string[],
		options: WithServicesOptions,
		command: (started: ServicesStarted) => Promise<T>,
	): Promise<T>;
	isRunning(): Promise<boolean>;
	runSeed(options?: SeedRunOptions): Promise<SeedOutcome>;
	/** Whether a `withServices` command is running with this service up. */
	readied(service: string): boolean;
	/** Start the machine-wide watchdog, not awaited; a failure is said once. */
	ensureWatchdog(): void;
}

/** What starting and stopping read of the environment. */
export type LifecycleContext = Pick<
	DevEnvContext,
	| "config"
	| "services"
	| "runtime"
	| "getStartPlan"
	| "prepareStartAsync"
	| "captureThrowawayClaim"
	| "composeFile"
	| "composeModel"
	| "ensureComposeFile"
	| "logInfo"
	| "onSecretsWait"
	| "ownedServerPids"
	| "output"
	| "assignedPortTargets"
	| "adoptAssignedPorts"
> &
	SeedContext &
	GeneratedFilesContext;

export function createLifecycleApi(
	ctx: LifecycleContext,
	envVars: DevEnvVarsApi,
	runClaim: DevRunClaimApi,
	coordinator: LifecycleCoordinator,
	serviceWatch: ServiceWatchApi,
	appPipeline: AppPipeline,
): DevLifecycleApi {
	const { config, services, ports } = ctx;

	/** What the latest preparation planned, for `runSeed` and the hooks. */
	let latest: { plan: PreparationPlan; prepared: Prepared } | undefined;
	/**
	 * What this environment's starts have brought up since its last teardown,
	 * whatever the latest one selected. `unknown` until a start gets that far:
	 * a stop then means the whole environment (`dev --down`). `none`: only
	 * starts that selected no service, whose stop leaves the containers to
	 * the run using them. `services`: a start claimed the run for containers,
	 * which stop tears down.
	 */
	let broughtUp: "unknown" | "none" | "services" = "unknown";
	/**
	 * The stacks those starts brought up. A stack has no state to ask its CLI
	 * for, so this is what `isRunning` knows of it.
	 */
	const stacksUp = new Set<string>();
	/** The services of the `withServices` commands running now, each started and waited for. */
	const commandServices = new Map<string, number>();

	let watchdogFailureSaid = false;
	/**
	 * Not awaited: confirming the watchdog came up is no reason to delay a
	 * start. A failure is said once, where the run's service changes are (the
	 * run's log in the CLI): without the watchdog nothing removes a crashed
	 * run's containers until a `ls` or `doctor` sweeps.
	 */
	function ensureWatchdog(): void {
		void runClaim.ensureWatchdog().catch((error: unknown) => {
			if (watchdogFailureSaid) return;
			watchdogFailureSaid = true;
			const reason = error instanceof Error ? error.message : String(error);
			serviceWatch.notify(
				`The watchdog did not start (${reason}). Ended runs' containers stay until \`buncargo ls\` or \`buncargo doctor\` sweeps; the next start tries again.`,
				true,
			);
		});
	}

	function appOnlyRun(): boolean {
		return broughtUp === "none" || Object.keys(services).length === 0;
	}

	function hookContext(signal?: AbortSignal) {
		return envVars.getHookContext(signal, latest?.prepared.selection);
	}

	async function runPrepareSteps(
		plan: PreparationPlan,
		options: {
			verbose: boolean;
			production: boolean;
			schema: "migrate" | "push";
			generate: boolean;
			signal?: AbortSignal;
			onPhase?: (name: string, ms: number) => void;
		},
	): Promise<void> {
		const { verbose, signal, onPhase } = options;
		const execute: typeof envVars.exec = (cmd, execOptions) =>
			envVars.exec(
				cmd,
				{
					...execOptions,
					signal,
					timeoutMs: execOptions?.timeoutMs ?? 600000,
				},
				options.production,
			);
		const beforeMigrations = config.hooks?.beforeMigrations;
		if (beforeMigrations && plan.beforeMigrations) {
			await withDeadline(
				(hookSignal) => beforeMigrations(hookContext(hookSignal)),
				600000,
				signal,
			);
		}

		const { migrations } = plan;
		if (migrations.length > 0) {
			if (verbose) {
				ctx.output.log(formatStep("📦 Running migrations..."));
			}

			const elapsed = startTimer();
			try {
				await runMigrationsSequentially(
					migrations,
					execute,
					async (migration) =>
						options.schema === "migrate" &&
						migration.name === "prisma" &&
						(await prismaUpToDate(verbose, signal)),
				);
			} catch (error) {
				await explainSquashedChain(migrations, signal);
				throw error;
			} finally {
				onPhase?.("migrations", elapsed());
			}

			if (verbose) {
				ctx.output.log(formatDone("Migrations complete"));
			}
		}

		const generateCheck = config.prisma?.generateCheck;
		const generateNeeded = async (cwd: string) => {
			if (!generateCheck) return true;
			if (generateCheck === "schema-hash")
				return prismaClientStale(ctx.root, cwd);
			return withDeadline(
				async (hookSignal) => generateCheck(hookContext(hookSignal)),
				600_000,
				signal,
			);
		};
		if (
			options.generate &&
			plan.prismaSelected &&
			config.prisma?.generate &&
			(await generateNeeded(resolvePrismaConfig(config.prisma).cwd))
		) {
			if (verbose) {
				ctx.output.log(formatStep("📦 Generating Prisma client..."));
			}

			const elapsed = startTimer();
			try {
				const command = config.prisma.generate;
				const { cwd } = resolvePrismaConfig(config.prisma);
				await generatePrismaClient(ctx.root, cwd, () =>
					execute(command, {
						cwd,
						verbose,
						onOutputLine: ctx.output.commandLine,
					}),
				);
			} finally {
				onPhase?.("generation", elapsed());
			}

			if (verbose) {
				ctx.output.log(formatDone("Prisma generate complete"));
			}
		}
	}

	/**
	 * Whether every local migration is already applied to our own database, so
	 * `migrate deploy` has nothing to do. An overlay may target a different
	 * database; never skip that deploy based on the state of our local service.
	 */
	async function prismaUpToDate(
		verbose: boolean,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (!config.prisma) return false;
		const { service: serviceKey, urlEnvVar } = resolvePrismaConfig(
			config.prisma,
		);
		const service = services[serviceKey];
		const url = toUrlMap(ctx.loopbackUrls)[serviceKey];
		const computed: Record<string, string> = envVars.buildEnvVars();
		if (!service || computed[urlEnvVar] !== url) return false;
		const count = await appliedMigrationCount({
			root: ctx.root,
			prisma: config.prisma,
			service,
			url,
			signal,
		});
		if (count === undefined) return false;
		if (verbose) ctx.output.log(formatDone(`Migrations up to date (${count})`));
		return true;
	}

	/**
	 * After a failed deploy only, so a healthy start pays nothing: a database
	 * that applied migrations this checkout no longer has fails `migrate
	 * deploy` with a message that does not say so.
	 */
	async function explainSquashedChain(
		migrations: readonly MigrationConfig[],
		signal?: AbortSignal,
	): Promise<void> {
		if (signal?.aborted || !config.prisma) return;
		if (!migrations.some((migration) => migration.name === "prisma")) return;
		const prisma = resolvePrismaConfig(config.prisma);
		const url = toUrlMap(ctx.loopbackUrls)[prisma.service];
		if (!url) return;
		const missing = await missingAppliedMigrations(
			url,
			join(ctx.root, prisma.cwd, prisma.migrations),
		);
		if (!missing?.length) return;
		console.error(
			formatWarn(
				`The database applied ${missing.length} migration${missing.length === 1 ? "" : "s"} this checkout no longer has (${missing.join(", ")}): the chain was squashed or rewritten. Only recreating the database gets past it, and that drops its data: bunx buncargo dev --reset --yes. Ask before running it.`,
			),
		);
	}

	function runSeed(options: SeedRunOptions = {}): Promise<SeedOutcome> {
		if (latest && !latest.plan.seedSelected) {
			return Promise.resolve({ status: "not-needed" });
		}

		return runSeedIfNeeded(ctx, envVars, options, latest?.prepared.selection);
	}

	/**
	 * Wired here rather than offered as a hook: `beforeServers` never fires on
	 * the CLI path, which spawns its own apps.
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
			ctx.output.log(
				formatWarn(`No ${relative(ctx.root, result.path)} to sync; skipped`),
			);
			return;
		}

		if (result.created || result.changed.length > 0) {
			const what = result.created
				? "Created"
				: `Synced ${result.changed.length} value${result.changed.length === 1 ? "" : "s"} in`;
			ctx.output.log(formatDone(`${what} ${relative(ctx.root, result.path)}`));
		}
	}

	function start(
		startOptions: StartOptions = {},
	): Promise<DevServerPids | null> {
		return coordinator.start(
			async (signal) => {
				const options = {
					...startOptions,
					signal: anySignal(signal, startOptions.signal),
				};
				const prepared = await prepareEnvironment({
					...options,
					banner: options.verbose ?? config.options?.verbose ?? true,
				});
				const spawns =
					(options.startServers ?? true) &&
					(options.prepare ?? "all") === "all" &&
					Object.keys(prepared.apps).length > 0;
				if (!spawns) return null;

				try {
					const claimed = await appPipeline.claimApps(prepared, {
						signal: options.signal,
					});
					const pids = await appPipeline.spawn(claimed, {
						signal: options.signal,
						onSeedReady: () => {
							if (prepared.verbose)
								ctx.output.log(formatDone("All servers ready"));
						},
					});
					if (prepared.verbose) ctx.output.log(formatDone("Environment ready"));
					return pids;
				} catch (error) {
					containersStillRunning(prepared.hasServices);
					throw error;
				}
			},
			startOptions.signal,
			(pids) => pids !== null && Object.keys(pids).length > 0,
		);
	}

	function containersStillRunning(hasServices: boolean): void {
		if (!hasServices) return;
		console.error(
			formatStep(
				"ℹ Containers are still running. Use `bunx buncargo dev --down` to stop them now.",
			),
		);
	}

	/** The selection and preparation plan a start with these options makes. */
	function planFor(options: PrepareOptions) {
		const startPlan = ctx.getStartPlan(options.onlyApps, options.onlyServices);
		const selection = {
			appNames: startPlan.appNames,
			requiredServiceKeys: startPlan.requiredServiceKeys,
		};
		const plan = planPreparation(
			config,
			services,
			{
				requiredServiceKeys: selection.requiredServiceKeys,
				apps: startPlan.apps,
			},
			{
				prepare: options.prepare ?? "all",
				seed: options.seed ?? "auto",
				schema: options.schema ?? "migrate",
				spawn: options.startServers ?? true,
			},
		);
		return { apps: startPlan.apps, selection, plan };
	}

	async function secretsSession(options: PrepareOptions): Promise<void> {
		const { plan } = planFor(options);
		if (plan.secrets)
			await ensureSecretsSession(startSecretScopes(plan.secrets), {
				signal: options.signal,
			});
	}

	function prepare(options: PrepareOptions = {}): Promise<Prepared> {
		return coordinator.start(
			(signal) =>
				prepareEnvironment({
					...options,
					signal: anySignal(signal, options.signal),
				}),
			options.signal,
			() => false,
		);
	}

	async function prepareEnvironment(
		options: PrepareOptions,
	): Promise<Prepared> {
		const { signal, onPhase, prepare: mode = "all" } = options;
		signal?.throwIfAborted();

		async function phase<T>(name: string, work: () => Promise<T>): Promise<T> {
			const elapsed = startTimer();
			try {
				signal?.throwIfAborted();
				return await work();
			} finally {
				onPhase?.(name, elapsed());
			}
		}

		const {
			verbose = config.options?.verbose ?? true,
			wait = true,
			startServers = true,
			// One decision for the whole start: containers, migrations, the seed
			// and the apps all get the env of the commands that run. Without
			// servers the caller runs its own processes (the CLI's dev servers,
			// `startServers()`, `exec`), which are development unless asked.
			productionBuild = startServers && isCI(),
			seed: seedMode = "auto",
			schema = "migrate",
			onlyApps,
			onlyServices,
			autoStartDocker = config.docker?.autoStart,
		} = options;

		const { apps, selection, plan } = planFor(options);
		if (startServers && mode === "all") {
			assertAppWorkingDirectories(apps, ctx.root, productionBuild);
		}
		const hasServices = selection.requiredServiceKeys.length > 0;
		const prepared = (seed: PreparedSeed): Prepared => ({
			selection,
			apps,
			hasServices,
			productionBuild,
			verbose,
			watchdog: options.watchdog !== false,
			seed,
			onPhase,
		});
		// From the plan, before anything runs: the hooks and `runSeed` are told
		// the selection this preparation makes.
		latest = { plan, prepared: prepared({ kind: "none" }) };

		ctx.onSecretsWait = (ms) => onPhase?.("secrets", ms);
		const prefetchController = new AbortController();
		const prefetchSignal = anySignal(signal, prefetchController.signal);
		const prefetches = plan.secrets
			? prefetchSecrets({ ...plan.secrets, signal: prefetchSignal })
			: [];
		if (signal) registerAbortCleanup(signal, Promise.allSettled(prefetches));
		try {
			// Before the port block, the claim and the first container: an
			// expired Infisical session stops the start here, not after the containers inside
			// every app's own loader. The prefetch's own token, so no extra CLI.
			if (plan.secrets)
				await ensureSecretsSession(startSecretScopes(plan.secrets), {
					signal: prefetchSignal,
				});
			// After the session: an expired one changes nothing on the way out.
			if (options.replaceStaleStacks)
				await replaceStaleStacksOn(
					ctx.runtime,
					{ root: ctx.root, projectPrefix: config.projectPrefix },
					Object.values(ctx.ports),
					{ signal, verbose },
				);
			await ctx.prepareStartAsync(onlyApps, onlyServices, signal);
			if (hasServices) broughtUp = "services";
			else if (broughtUp === "unknown") broughtUp = "none";
			const portMap = toPortMap(ports);
			const targetPorts: Record<string, number> = {};
			for (const serviceKey of selection.requiredServiceKeys) {
				for (const name of [serviceKey, `${serviceKey}Secondary`]) {
					const port = portMap[name];
					if (port !== undefined) {
						targetPorts[name] = port;
					}
				}
			}

			// Claimed before anything is created, so the sweep never sees a fresh
			// container as unowned. The claim outlives this process: `stop()`
			// retires it, `releaseRun()` releases it, and the sweep reads an
			// owner that died without either as a crash.
			if (hasServices) {
				await runClaim.claimRun({ ...options.claim, signal });
				// A script that starts containers and then crashes needs someone to
				// clean up after it, exactly as a `buncargo dev` does.
				if (options.watchdog !== false) ensureWatchdog();
			}

			if (options.banner) {
				ctx.logInfo(
					productionBuild ? "Production Environment" : "Dev Environment",
					undefined,
					selection,
				);
			}

			// Both subsets must fingerprint the same Compose artifact.
			let artifactReady = false;

			async function ensureSubset(
				subset: Record<string, ResolvedService>,
				noDeps = false,
			) {
				// Stacks start themselves, beside Compose rather than after it.
				const compose = composeServicesOf(subset);
				const stacks = stacksForServices(config, Object.keys(subset));
				if (Object.keys(compose).length === 0 && stacks.length === 0) {
					return;
				}

				async function composeUp() {
					if (!artifactReady) {
						ctx.ensureComposeFile();
						artifactReady = true;
					}

					const { assignedHostPorts } = await ensureServicesRunning({
						signal,
						runtime: ctx.runtime,
						root: ctx.root,
						projectName: ctx.projectName,
						projectPrefix: config.projectPrefix,
						envVars: envVars.buildEnvVars(productionBuild),
						services: compose,
						noDeps,
						ports: targetPorts,
						model: ctx.composeModel(),
						composeFile: ctx.composeFile,
						verbose,
						wait,
						autoStartRuntime: autoStartDocker,
						runtimeStartCommand: config.docker?.startCommand,
						assignedPorts: ctx.assignedPortTargets(Object.keys(compose)),
					});
					// Before the dotenv, migrations and anything else that reads a
					// service's port.
					ctx.adoptAssignedPorts(assignedHostPorts);
				}

				// One hold over Compose and the stacks: the sweep and `stop` take the
				// same lock, so neither can tear a stack down while it comes up. The
				// lock is not reentrant; nothing inside may take it again. Every
				// step settles before it is released: one failing must not free the
				// lock while `compose up` or another stack is still coming up.
				await phase("containers", () =>
					withProjectLifecycleLock(
						ctx.projectName,
						ctx.root,
						async () => {
							const results = await Promise.allSettled([
								Object.keys(compose).length > 0 ? composeUp() : undefined,
								...stacks.map(async ({ name, stack }) => {
									await withDeadline(
										(stackSignal) => stack.up(hookContext(stackSignal)),
										600_000,
										signal,
									);
									stacksUp.add(name);
								}),
							]);
							for (const result of results)
								if (result.status === "rejected") throw result.reason;
						},
						{ signal },
					),
				);
			}

			if (hasServices) {
				await ensureSubset(plan.earlyServices);
				serviceWatch.watch(Object.keys(plan.earlyServices));
				if (wait) runClaim.servicesReady(Object.keys(plan.earlyServices));
			}

			// Before migrations, not just before servers: Prisma and friends read
			// `.env` off disk themselves, so a stale port fails the migrate step.
			await phase("dotenv", () => syncConfiguredEnvFile(verbose));
			// Before anything reads them: values not known yet (a tunnel URL, a
			// capture) render as the file's placeholder and re-render later.
			for (const path of renderGeneratedFiles(ctx, envVars)) {
				if (verbose) ctx.output.log(formatDone(`Generated ${path}`));
			}
			if (mode === "containers") return prepared({ kind: "none" });

			try {
				await runPrepareSteps(plan, {
					verbose,
					production: productionBuild,
					schema,
					generate: mode !== "migrate",
					signal,
					onPhase,
				});
				if (mode === "migrate") return prepared({ kind: "none" });

				const afterContainersReady = config.hooks?.afterContainersReady;
				if (afterContainersReady && plan.afterContainersReady) {
					await phase("container hooks", () =>
						withDeadline(
							(hookSignal) => afterContainersReady(hookContext(hookSignal)),
							600_000,
							signal,
						),
					);
				}

				if (
					config.seed?.beforeApps === false &&
					Object.keys(plan.lateServices).length > 0 &&
					verbose
				) {
					ctx.output.log(
						formatStep(
							"Seed will run before apps because selected services use afterPreparation.",
						),
					);
				}
				const seed = await prepareSeed(plan, seedMode, (seedOptions) =>
					phase("seed", () =>
						runSeed({ verbose, productionBuild, signal, ...seedOptions }),
					),
				);

				// Early jobs already completed. --no-deps prevents Compose from rerunning them.
				await ensureSubset(plan.lateServices, true);
				serviceWatch.watch(Object.keys(plan.lateServices));
				if (wait) runClaim.servicesReady(Object.keys(plan.lateServices));

				const result = prepared(seed);
				latest = { plan, prepared: result };
				return result;
			} catch (error) {
				containersStillRunning(hasServices);
				throw error;
			}
		} catch (error) {
			prefetchController.abort(error);
			await Promise.allSettled(prefetches);
			throw error;
		}
	}

	/**
	 * The seed's place in this start. A forced seed runs here and hands its
	 * outcome to the caller, who chose to force it; an automatic one that
	 * fails fails the start.
	 */
	async function prepareSeed(
		plan: PreparationPlan,
		mode: "auto" | "force" | "skip",
		run: (options: { force?: boolean }) => Promise<SeedOutcome>,
	): Promise<PreparedSeed> {
		if (mode === "skip") return { kind: "none" };
		if (mode === "force")
			return { kind: "ran", outcome: await run({ force: true }) };
		if (plan.seedOverlaps) return { kind: "overlap" };
		if (!plan.seedSelected) return { kind: "none" };
		const outcome = await run({});
		assertSeedSucceeded(outcome);
		return { kind: "ran", outcome };
	}

	async function withServices<T>(
		names: readonly string[],
		options: WithServicesOptions,
		command: (started: ServicesStarted) => Promise<T>,
	): Promise<T> {
		const { after = "release", prepare: mode = "containers" } = options;
		try {
			const prepared = await prepare({
				...options,
				onlyServices: names,
				startServers: false,
				prepare: mode,
				seed: options.seed ?? (mode === "all" ? "auto" : "skip"),
			});
			for (const name of names)
				commandServices.set(name, (commandServices.get(name) ?? 0) + 1);
			try {
				return await command({
					seed:
						prepared.seed.kind === "ran" ? prepared.seed.outcome : undefined,
				});
			} finally {
				for (const name of names) {
					const count = (commandServices.get(name) ?? 1) - 1;
					if (count > 0) commandServices.set(name, count);
					else commandServices.delete(name);
				}
			}
		} finally {
			if (after === "release") {
				serviceWatch.stop();
				await runClaim.releaseRun();
			} else
				await stop({
					removeVolumes: after.stop.removeVolumes,
					verbose: options.verbose,
				});
		}
	}

	function stop(stopOptions: StopOptions = {}): Promise<void> {
		return coordinator.stop(async () => {
			// A claim lives as long as its directory, and a CI runner's persists
			// between jobs: its claims and every E2E stack's filled the machine's
			// blocks.
			const releaseClaim = ctx.captureThrowawayClaim();
			if (await stopEnvironment(stopOptions)) await releaseClaim();
		}, stopOptions.signal);
	}

	/**
	 * Whether nothing of the environment is left that could use its block.
	 * Every step runs even when an earlier one fails, and the first failure
	 * is thrown at the end: a `beforeStop` hook that throws must not leave
	 * the apps, their leases, the containers and the entry behind.
	 */
	async function stopEnvironment(stopOptions: StopOptions): Promise<boolean> {
		const {
			verbose = true,
			removeVolumes = false,
			force = false,
			signal,
		} = stopOptions;
		signal?.throwIfAborted();
		const errors: unknown[] = [];
		async function step(work: () => Promise<void>): Promise<boolean> {
			try {
				await work();
				return true;
			} catch (error) {
				errors.push(error);
				return false;
			}
		}
		function settled(nothingLeft: boolean): boolean {
			if (errors.length > 0) throw errors[0];
			return nothingLeft;
		}

		// Before anything comes down: this run's own teardown is not news.
		serviceWatch.stop();
		const beforeStop = config.hooks?.beforeStop;
		if (beforeStop)
			await step(() =>
				withDeadline(
					(hookSignal) => beforeStop(hookContext(hookSignal)),
					600000,
					signal,
				),
			);

		await step(() => stopDevServers(ctx.ownedServerPids));
		for (const name of Object.keys(ctx.ownedServerPids))
			delete ctx.ownedServerPids[name];
		await step(() => runClaim.releaseApps());
		if (appOnlyRun()) {
			// Another run's containers may still use the block, unless the
			// config has none.
			return settled(Object.keys(services).length === 0);
		}

		const hasCompose = Object.keys(composeServicesOf(services)).length > 0;
		// Every stack, not just this run's selection: stop means the environment.
		const stacks = configuredStacks(config);
		let down = true;
		let kept = false;
		if (hasCompose || stacks.length > 0) {
			down = await step(() =>
				withProjectLifecycleLock(
					ctx.projectName,
					ctx.root,
					async () => {
						// Read under the lock every start takes before its
						// containers: no run can claim them between this and the
						// teardown.
						const keepers = force
							? []
							: await readRunsKeepingServices(ctx.root, {
									projectName: ctx.projectName,
									sessionId: runClaim.sessionId,
								});
						if (keepers.length > 0) {
							kept = true;
							if (verbose) {
								const pids = keepers.map((run) => run.pid).join(", ");
								ctx.output.log(
									formatStep(
										`Kept ${ctx.projectName}'s services: another run uses them (pid ${pids}). stop({ force: true }) tears them down anyway.`,
									),
								);
							}
							return;
						}
						// Each comes down whatever the one before did: a stack that
						// fails must not leave the rest up. The first failure is
						// thrown once all have been tried.
						const failures: unknown[] = [];
						if (hasCompose) {
							ctx.ensureComposeFile();
							await ctx.runtime
								.down({
									root: ctx.root,
									projectName: ctx.projectName,
									model: ctx.composeModel(),
									composeFile: ctx.composeFile,
									verbose,
									removeVolumes,
									signal,
								})
								.catch((error: unknown) => failures.push(error));
						}

						for (const { name, stack } of stacks) {
							try {
								await envVars.execTeardown(
									stack.down({
										projectName: ctx.projectName,
										root: ctx.root,
										removeVolumes,
									}),
									{ secrets: false, signal, timeoutMs: 120_000 },
								);
								if (verbose) ctx.output.log(formatDone(`Stopped ${name}`));
							} catch (error) {
								failures.push(error);
							}
						}
						if (failures.length > 0) throw failures[0];
					},
					{ signal },
				),
			);
			down &&= !kept;
			if (down)
				await step(() =>
					recordTeardown(ctx, {
						sessionId: runClaim.sessionId,
						runtimes: [
							...(hasCompose ? [ctx.runtime.name] : []),
							...stacks.map(({ name }) => name),
						],
						removeVolumes,
					}),
				);
		}
		// Containers that did not come down, or that another run keeps, stay
		// on record, released, for the next `stop` or the sweep to find.
		await step(() =>
			down
				? runClaim.retireRun({ containersDown: hasCompose })
				: runClaim.releaseRun(),
		);
		if (down || kept) {
			broughtUp = "unknown";
			stacksUp.clear();
		}
		return settled(down);
	}

	async function isRunning(): Promise<boolean> {
		if (appOnlyRun()) {
			return false;
		}

		const stacks = configuredStacks(config);
		if (!stacks.every(({ name }) => stacksUp.has(name))) return false;
		// A job's container has exited once it did its work.
		const compose = Object.fromEntries(
			Object.entries(composeServicesOf(services)).filter(
				([, service]) => service.kind !== "job",
			),
		);
		const names = resolveComposeServiceNames(services, Object.keys(compose));
		if (names.length === 0) return stacks.length > 0;
		// Throws when the runtime cannot answer, which is not running either.
		const states = await projectServiceStates(
			ctx.runtime,
			ctx.projectName,
		).catch(() => []);
		const running = new Set(
			states.filter((state) => state.serving).map((state) => state.service),
		);
		return names.every((name) => running.has(name));
	}

	return {
		start,
		prepare,
		secretsSession,
		stop,
		withServices,
		isRunning,
		runSeed,
		readied: (service) => commandServices.has(service),
		ensureWatchdog,
	};
}
