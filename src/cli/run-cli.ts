import { execSync } from "node:child_process";
import { getErrorMessage, startTimer, typedSwitch } from "hanzio";
import {
	containerRuntimeForEnv,
	replaceStaleStacksOn,
} from "../container-runtime";
import { describeLeaseRefusal } from "../core/app-leases";
import { withSignal } from "../core/deadline";
import {
	getRoutesPath,
	removeHostRoutes,
	routesDownRemoves,
} from "../core/hosts";
import { releaseLeases } from "../core/leases";
import { askConfirm, PromptInterruptedError } from "../core/prompt";
import {
	flushRunPatches,
	recordAppUrls,
	recordRunCapture,
} from "../core/run-publish";
import { detachedRunMode, isCI } from "../core/runtime-flags";
import { formatStep, formatWarn, joinColoredNames } from "../core/style";
import {
	createNoopPhaseTimer,
	createPhaseTimer,
	type PhaseTimer,
} from "../core/timing";
import {
	resolveExposeTargets,
	startPublicTunnels,
	stopPublicTunnels,
} from "../core/tunnel";
import { WATCHDOG_IDLE_TIMEOUT_MS } from "../core/watchdog-constants";
import {
	type EnvironmentInternals,
	internalsOf,
	type PreparedSeed,
	type PrepareOptions,
} from "../environment";
import {
	assertSeedSucceeded,
	SeedFailedError,
} from "../environment/seed-startup";
import { planStart } from "../planning";
import type {
	AnyDevEnvironment,
	AppConfig,
	CliOptions,
	DevEnvironment,
	ResolvedApp,
	SeedOutcome,
	ServiceConfig,
} from "../types";
import { checkMenuBarAppUpdate, offerMenuBarApp } from "./bar-offer";
import {
	checkFailureError,
	describeCheckFailures,
	isWarning,
	runChecks,
} from "./checks";
import { formatCommandHelp } from "./command-spec";
import { devCommand } from "./commands/dev";
import { allChecks } from "./core-checks";
import { createDevConnect, type DevConnect } from "./dev-connect";
import {
	type DevArgs,
	destructiveModeGate,
	exposeRequested,
	exposeTargets,
	ignoredFlagWarnings,
	isOneShot,
	parseDevArgs,
	requestedApps,
	timingRequested,
	tuiMode,
} from "./dev-flags";
import {
	activateNamedHosts,
	machineNamedHostsDeps,
	type NamedHostsTarget,
	reclaimAppRoute,
	releaseNamedHosts,
} from "./dev-hosts";
import { listenForInterrupts } from "./dev-interrupts";
import {
	cliLeasePolicy,
	leaseSkipLines,
	leaseTakeoverHints,
	warnSkippedLeaseApps,
} from "./dev-leases";
import { openDevOutput } from "./dev-output";
import {
	acceptTakeover,
	initialTakeover,
	shouldOfferTakeover,
} from "./dev-takeover";
import {
	createTunnelCoordinator,
	type DevTunnelCoordinator,
} from "./dev-tunnels";
import { CliError } from "./errors";
import * as log from "./log";
import {
	classifyCliApps,
	type UnhealthyApp,
	unhealthyAppMessage,
} from "./port-reuse";
import { runPreflight } from "./preflight";
import {
	type DevFailureContext,
	describeAppFailure,
	describeDevFailure,
	formatRunFailure,
	type RunFailure,
} from "./run-failure";
import {
	isInteractive,
	promptTakeover,
	promptUnhealthyTakeover,
	stopRunningApps,
	type TakeoverCandidates,
	takeoverCandidates,
} from "./takeover";
import {
	assertConfiguredApps,
	seedSelectionError,
	validateDevStart,
} from "./validate-dev-start";

/** `undefined` keeps the process alive; a number is the exit code to use. */
type DevFlowExit = number | undefined;

function restoreTerminal(): void {
	if (!process.stdin.isTTY && !process.stdout.isTTY) {
		return;
	}
	try {
		execSync("stty sane", { stdio: "ignore" });
	} catch {
		// Missing stty or not a real terminal.
	}
}

function logSelectedAppsSummary(input: {
	startNames: string[];
	reusedNames: string[];
	inferredReuseNames: string[];
	skippedNames?: string[];
}): void {
	const { startNames, reusedNames, inferredReuseNames } = input;
	const skippedNames = input.skippedNames ?? [];

	log.line();
	if (startNames.length > 0) {
		log.info(`🔧 Starting: ${joinColoredNames(startNames)}`);
	}
	if (reusedNames.length > 0) {
		log.info(`♻️  Reusing: ${joinColoredNames(reusedNames)}`);
	}
	if (inferredReuseNames.length > 0) {
		log.info(
			`ℹ Inferred reuse from busy port: ${joinColoredNames(inferredReuseNames)}`,
		);
	}
	if (skippedNames.length > 0) {
		log.info(
			`⏭️  Skipped (lease held by another run): ${joinColoredNames(skippedNames)}`,
		);
	}
}

/**
 * How long this run's containers are held after it exits.
 *
 * `false` means as long as the checkout exists: what `--keep-containers`
 * asks for, and what a one-shot mode like `--up-only` means by leaving them
 * up. `undefined` defers to `options.autoShutdown`.
 */
function resolveIdleTimeout(args: DevArgs): number | false | undefined {
	if (args.values["keep-containers"]) return false;
	// Before the one-shot default: `--up-only --watchdog-timeout=5` is someone
	// asking for a hold in as many words, and silently ignoring it would leave
	// the containers up forever.
	const minutes = args.values["watchdog-timeout"];
	if (minutes !== undefined) return Number.parseInt(minutes, 10) * 60_000;
	if (isOneShot(args.values)) return false;
	return undefined;
}

function waitForShutdownSignal(signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		const done = () => {
			process.off("SIGINT", done);
			process.off("SIGTERM", done);
			process.off("SIGHUP", done);
			signal.removeEventListener("abort", done);
			resolve();
		};
		process.on("SIGINT", done);
		process.on("SIGTERM", done);
		process.on("SIGHUP", done);
		signal.addEventListener("abort", done, { once: true });
		if (signal.aborted) done();
	});
}

/**
 * Run the CLI for a dev environment. Exits the process with the run's code
 * once it ends, unless it ended because its apps did.
 */
export async function runCli<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	options: CliOptions & {
		timer?: PhaseTimer;
		/** `args` already parsed, by `buncargo dev`. */
		parsed?: DevArgs;
	} = {},
): Promise<void> {
	const code = await runDevCommand(env, options);
	if (code !== undefined) process.exit(code);
}

/**
 * `args` parsed, or 1 after printing why it does not parse: programmatic
 * callers reach `runCli` with argv of their own.
 */
function devArgsOf(
	options: CliOptions & { parsed?: DevArgs },
): DevArgs | number {
	if (options.parsed) return options.parsed;
	try {
		const parsed = parseDevArgs(options.args ?? process.argv.slice(2));
		if (!parsed.help) return parsed;
		console.log(formatCommandHelp(devCommand));
		return 0;
	} catch (error) {
		if (!(error instanceof CliError)) throw error;
		log.error(error.message);
		for (const hint of error.hints) log.hint(hint);
		return 1;
	}
}

/**
 * The dev command, from argv to the exit code. Every path out passes one
 * `finally`, which reports the timing, tears the run down once and prints a
 * failure last.
 */
async function runDevCommand<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	options: CliOptions & {
		timer?: PhaseTimer;
		parsed?: DevArgs;
	},
): Promise<DevFlowExit> {
	const { watchdog = true } = options;
	const args = devArgsOf(options);
	if (typeof args === "number") return args;
	for (const warning of ignoredFlagWarnings(args.values)) log.warn(warning);

	if (args.values.detach && detachedRunMode() !== undefined) {
		// The background run re-detaching would start another, without end.
		log.error(
			"--detach reached a run that is already in the background; it was not started again.",
		);
		return 1;
	}
	if (args.values.detach) {
		const { DETACH_TIMEOUT_MS, runDetached } = await import("./dev-detach");
		return runDetached({
			root: env.root,
			keep: args.values.keep,
			json: args.values.json,
			argv: process.argv,
			timeoutMs: DETACH_TIMEOUT_MS,
		});
	}

	// The apps whose processes are running: a second signal waits for them.
	const runningApps = new Set<string>();
	// The first SIGINT/SIGTERM/SIGHUP aborts the run with `RunInterrupted`; a
	// second exits, unless apps are still stopping (`dev-interrupts.ts`).
	const interrupts = listenForInterrupts({
		clock: () => performance.now(),
		stopping: () => [...runningApps],
		warn: (apps) => {
			const names = apps.join(", ");
			log.warn(
				`Still stopping ${names}: an app can take its stopGraceMs to save data. Ctrl-C again to exit without waiting, which can lose that data.`,
			);
		},
		forceExit: (code) => {
			// After the TUI's own `exit` handler, which leaves its screen.
			process.once("exit", () => {
				restoreTerminal();
				log.errorNow("Interrupted again: exiting before cleanup finished.", [
					"The next `buncargo dev` here replaces anything left running; the containers wait out their idle hold.",
				]);
			});
			process.exit(code);
		},
	});
	const controller = new AbortController();
	interrupts.signal.addEventListener(
		"abort",
		() => controller.abort(interrupts.signal.reason),
		{ once: true },
	);
	// A throw or rejection nothing caught ends the run the way a failure
	// does: its apps stopped and the teardown awaited. Unhandled, it killed
	// this process and left every app running.
	let crash: { error: unknown } | undefined;
	const onCrash = (error: unknown) => {
		crash ??= { error };
		controller.abort(error);
	};
	process.on("uncaughtException", onCrash);
	process.on("unhandledRejection", onCrash);
	const tunnels = createTunnelCoordinator(
		env,
		{ resolveExposeTargets, startPublicTunnels, stopPublicTunnels },
		{
			exposeRequested: exposeRequested(args.values),
			signal: controller.signal,
		},
	);

	const timer =
		options.timer ??
		(timingRequested(args.values)
			? createPhaseTimer({ json: args.values["timing-json"] })
			: createNoopPhaseTimer());

	let connect: DevConnect | undefined;
	let exitCode: DevFlowExit;
	let failure: RunFailure | undefined;
	const failureContext: DevFailureContext = { setupHints: [] };
	try {
		if (!isOneShot(args.values) && !args.values.down && !args.values.reset)
			connect = createDevConnect();
		exitCode = await runDevFlow(env, args, tunnels, {
			watchdog,
			connect,
			timer,
			signal: controller.signal,
			failureContext,
			runningApps,
		});
		// A run that only held services returns normally from the abort.
		if (crash) throw crash.error;
	} catch (thrown) {
		const error = crash ? crash.error : thrown;
		controller.abort(error);
		exitCode = 1;
		// The prompt re-raises SIGINT, which arrives after this.
		if (error instanceof PromptInterruptedError) interrupts.promptInterrupted();
		if (interrupts.exitCode() === undefined)
			failure = describeDevFailure(error, failureContext);
		if (failure && detachedRunMode() !== undefined) {
			const { recordDetachedReport } = await import("./dev-detach");
			const reported = failure;
			recordDetachedReport(env.root, (report) => ({
				...report,
				failures: [...report.failures, reported],
			}));
		}
	} finally {
		// A run interrupted before it was ready ends here too; its breakdown
		// is the one `--timing` was asked for.
		timer.report();
		try {
			await teardown(env, tunnels, connect);
		} finally {
			// Last, after teardown's own messages: agents read `dev | tail`.
			if (failure) {
				const { message, hints } = formatRunFailure(failure);
				log.errorNow(message, hints);
			}
			interrupts.dispose();
			process.off("uncaughtException", onCrash);
			process.off("unhandledRejection", onCrash);
		}
	}

	// 128 + the signal however an interrupted run ended: one that only held
	// services or tunnels returns normally from the signal.
	return interrupts.exitCode() ?? exitCode;
}

/** The environment's named hosts, with the switch its internals hold. */
function namedHostsOf(
	env: Pick<AnyDevEnvironment, "root" | "hosts" | "ports">,
): NamedHostsTarget {
	return {
		root: env.root,
		hosts: env.hosts,
		ports: env.ports,
		setNamedHostsActive: internalsOf(env).setNamedHostsActive,
	};
}

async function teardown<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	tunnels: DevTunnelCoordinator<TServices, TApps>,
	connect?: DevConnect,
): Promise<void> {
	await flushRunPatches(env);
	try {
		const hosts = releaseNamedHosts(namedHostsOf(env));
		const results = await Promise.allSettled([
			tunnels.stop(),
			connect?.stop(),
			hosts,
			releaseLeases(env.sessionId),
			// Releases rather than withdraws: a run that owns containers leaves
			// its entry behind, because that entry is what tells the sweep the
			// containers may still be reused and for how long. A run with none
			// is withdrawn outright, there being nothing to come back for.
			env.releaseRun(),
		]);
		for (const result of results)
			if (result.status === "rejected")
				log.warn(`Cleanup failed: ${String(result.reason)}`);
		for (const warning of await hosts.catch(() => [])) log.warn(warning);
	} finally {
		restoreTerminal();
	}
}

/** Ask, or refuse without a terminal, before `--reset` or `--down --all`. */
async function confirmDestructiveMode(
	env: { projectName: string },
	args: DevArgs,
): Promise<void> {
	const gate = destructiveModeGate(args.values, {
		interactive: isInteractive(),
		ci: isCI(),
	});
	if (gate === "run") return;

	const what = args.values.reset
		? `--reset removes ${env.projectName}'s volumes, including its database.`
		: "--down --all stops every buncargo environment you started on this machine, including other checkouts' runs.";
	await typedSwitch(gate, {
		refuse: () => {
			throw new CliError(`${what} Refusing without a terminal.`, [
				"Pass --yes if that is really what you want.",
			]);
		},
		confirm: async () => {
			if (!(await askConfirm([`  ${what}`, "  Continue? [y/N]"])))
				throw new CliError("Cancelled.");
		},
	});
}

/** How the apps a run selected divide: started here, or reused from another process. */
export interface ClassifiedApps {
	readonly startApps: Record<string, ResolvedApp>;
	readonly reusedApps: Record<string, ResolvedApp>;
	readonly startNames: string[];
	readonly reusedNames: string[];
	readonly inferredReuseNames: string[];
	readonly unhealthy: UnhealthyApp[];
}

/** The classification once the takeover moved `taken` here: started, no longer reused. */
export function withTakenOver(
	classified: ClassifiedApps,
	taken: { names: readonly string[]; apps: Record<string, ResolvedApp> },
): ClassifiedApps {
	const moved = new Set(taken.names);
	return {
		startApps: { ...classified.startApps, ...taken.apps },
		startNames: [...classified.startNames, ...taken.names],
		reusedApps: Object.fromEntries(
			Object.entries(classified.reusedApps).filter(
				([name]) => !moved.has(name),
			),
		),
		reusedNames: classified.reusedNames.filter((name) => !moved.has(name)),
		inferredReuseNames: classified.inferredReuseNames.filter(
			(name) => !moved.has(name),
		),
		unhealthy: classified.unhealthy.filter((app) => !moved.has(app.name)),
	};
}

/**
 * What a run does once its leases are taken: spawn its apps, `hold` what it
 * has (services, tunnels it opens, sharing) until it is told to stop, end
 * because every selected app already runs elsewhere, or refuse because a
 * lease held elsewhere left it with nothing at all.
 */
export function decideSpawn(input: {
	startNames: readonly string[];
	reusedNames: readonly string[];
	leaseSkips: number;
	servicesOnly: boolean;
	pendingTunnels: boolean;
	sharing: boolean;
}): "spawn" | "hold" | "already-running" | "refuse" {
	if (input.startNames.length > 0) return "spawn";
	const keepsOpen = input.pendingTunnels || input.sharing;
	if (input.leaseSkips > 0 && input.reusedNames.length === 0 && !keepsOpen)
		return "refuse";
	if (input.servicesOnly || keepsOpen) return "hold";
	return "already-running";
}

/**
 * The dev command flow. Returns an exit code for the one-shot modes and
 * `undefined` when the caller should simply return. Failures throw
 * `CliError`; the caller reports them and tears the run down.
 */
async function runDevFlow<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	args: DevArgs,
	tunnels: DevTunnelCoordinator<TServices, TApps>,
	options: {
		watchdog: boolean;
		timer: PhaseTimer;
		signal: AbortSignal;
		connect?: DevConnect;
		/** Filled in as the run goes, for the block a failure ends on. */
		failureContext: DevFailureContext;
		/** Kept to the apps whose processes are running, for the run's signals. */
		runningApps: Set<string>;
	},
): Promise<DevFlowExit> {
	const { timer, signal, connect, failureContext } = options;
	const pipeline = internalsOf(env);
	// Loaded only in the background run that reports to `dev --detach`.
	const detached =
		detachedRunMode() !== undefined ? await import("./dev-detach") : undefined;

	await confirmDestructiveMode(env, args);

	if (args.values.down && args.values.all) {
		const { stopAllBuncargoEnvironments } = await import("./commands/inspect");
		await stopAllBuncargoEnvironments();
		return 0;
	}

	if (args.values.down || args.values.reset) {
		env.logInfo();
		// The containers come first: a registry that cannot be rewritten must
		// not leave them running, and its own message says how to fix it.
		try {
			await removeHostRoutes(routesDownRemoves(env.root));
		} catch (error) {
			const message = `Left this checkout's service routes in ${getRoutesPath()}: ${getErrorMessage(error)}`;
			log.warn(message);
		}
		// `--reset` was confirmed for exactly this; `--down` keeps services
		// another live run uses, and says so.
		await env.stop({
			removeVolumes: args.values.reset,
			force: args.values.reset,
			signal,
		});
		return 0;
	}

	// ── App selection ────────────────────────────────────────────────────────
	const selectedAppNames = selectDevApps(env, args);

	const plan = planStart(env.apps, env.services, {
		onlyApps: selectedAppNames,
	});
	const appsForDev = plan.apps;
	validateDevStart(
		env,
		args,
		appsForDev,
		plan.requiredServiceKeys,
		internalsOf(env).seed,
	);
	// What `dev --detach` waits for, which only this run knows: it never
	// loads the config itself.
	detached?.recordDetachedReport(env.root, (report) => ({
		...report,
		expectApps: Object.values(appsForDev).some(
			(app) => app.devCommand !== false,
		),
	}));

	const prepareOptions: PrepareOptions = {
		watchdog: options.watchdog,
		signal,
		wait: true,
		// The seed overlaps the apps only in a run that spawns them.
		startServers: !isOneShot(args.values),
		seed: args.values.seed ? "force" : isOneShot(args.values) ? "skip" : "auto",
		prepare: args.values["up-only"]
			? "containers"
			: args.values.migrate
				? "migrate"
				: "all",
		onPhase: timer.record,
		onlyApps: selectedAppNames,
		autoStartDocker: !args.values["no-docker-autostart"] ? undefined : false,
		// The dev servers below run their dev commands in CI too.
		productionBuild: false,
		// Only the CLI knows the hold its flags ask for. Claimed whether or
		// not a watchdog is wanted: the claim is what says the containers are
		// somebody's, and the registry has to say so either way.
		claim: {
			idleTimeoutMs: resolveIdleTimeout(args),
			defaultIdleTimeoutMs: WATCHDOG_IDLE_TIMEOUT_MS,
		},
	};

	// Fired now, awaited before named hosts and the claim: an expired
	// Infisical session stops the run before any container or app starts, with
	// the login to run, instead of hanging inside every app's own loader. It
	// overlaps the checks and preflight; `prepare()` and the apps reuse its
	// token.
	const secretsSession = pipeline.secretsSession(prepareOptions);
	void secretsSession.catch(() => {});

	// Before anything is started: a missing generated file fails here with its
	// fix, instead of deep inside whichever app imports it first. Only the fast
	// checks: this runs on every start in every worktree.
	if (!isOneShot(args.values)) {
		const anyEnv = env as unknown as AnyDevEnvironment;
		const checks = allChecks(anyEnv, pipeline.setupChecks).filter(
			(check) => check.fast !== false,
		);
		const failed = (
			await timer.measure("checks", () =>
				runChecks(checks, { root: env.root, env: anyEnv }),
			)
		).filter((result) => !result.ok);
		// The steps below take no signal: a Ctrl-C during one is seen at the
		// next boundary, before anything else starts.
		signal.throwIfAborted();
		const warnings = describeCheckFailures(failed.filter(isWarning));
		for (const line of warnings) log.warn(line);
		// Repeated with a failure, at the end, which is where it is read.
		failureContext.setupHints = warnings;
		detached?.recordDetachedReport(env.root, (report) => ({
			...report,
			setupHints: warnings,
		}));
		const errors = failed.filter((result) => !isWarning(result));
		if (errors.length > 0) throw checkFailureError(errors);
		await timer.measure("preflight", () =>
			runPreflight(anyEnv, pipeline.preflight, Object.keys(appsForDev)),
		);
		signal.throwIfAborted();
	}
	connect?.plan(appsForDev, plan.requiredServiceKeys, env.services);
	if (connect && !connect.active)
		log.info("No selected endpoints to share through frp.");
	// Before the ports are allocated: a stale stack still holding them would
	// move this checkout's block, or fail the service preflight.
	// Removing a stack is not undone by a retry: the session first. Allocating
	// below overlaps it, and only does what the next run would do again.
	if (args.values["replace-stale"]) {
		await timer.measure("secrets session", () => secretsSession);
		await timer.measure("stale stacks", () =>
			replaceStaleStacksOn(
				containerRuntimeForEnv(env),
				{ root: env.root, projectPrefix: env.projectPrefix },
				Object.values(env.ports),
				{ signal },
			),
		);
	}
	await env.prepareStartAsync(selectedAppNames, undefined, signal);
	const hasServices = plan.requiredServiceKeys.length > 0;

	await timer.measure("secrets session", () => secretsSession);

	// ── Containers ───────────────────────────────────────────────────────────
	// Held rather than printed: a run that takes over another one activates a
	// second time, and only that attempt describes the URLs the banner prints.
	let hostsWarnings = isOneShot(args.values)
		? []
		: await timer.measure("hosts", () =>
				activateNamedHosts(
					namedHostsOf(env),
					{ enabled: !args.values["no-hosts"], signal },
					machineNamedHostsDeps,
				),
			);
	// After named hosts, which owns the first-run prompt slot on a fresh
	// machine, and before the containers, so a question cannot land in the
	// middle of startup output.
	if (!isOneShot(args.values)) {
		signal.throwIfAborted();
		await offerMenuBarApp(signal);
	}
	// Kept for the TUI, which covers the scrollback they were printed in.
	const printedHostsWarnings: string[] = [];
	const flushHostsWarnings = (): void => {
		for (const warning of hostsWarnings) log.warn(warning);
		printedHostsWarnings.push(...hostsWarnings);
		// `dev --detach` repeats them: the fallback to localhost:port is
		// otherwise silent.
		const reported = hostsWarnings;
		if (reported.length > 0)
			detached?.recordDetachedReport(env.root, (report) => ({
				...report,
				hostsWarnings: [...report.hostsWarnings, ...reported],
			}));
		hostsWarnings = [];
	};
	signal.throwIfAborted();
	// What preparation says about the run before its output opens (the
	// watchdog not starting): printed now, and kept for the run's log and the
	// TUI.
	const earlyReports: { message: string; problem: boolean }[] = [];
	pipeline.notify((message, problem) => {
		earlyReports.push({ message, problem });
		(problem ? log.warn : log.info)(message);
	});
	const prepared = await pipeline.prepare(prepareOptions);
	const overlapSeed = prepared.seed.kind === "overlap";

	let classifiedApps: ClassifiedApps = isOneShot(args.values)
		? {
				startApps: {},
				reusedApps: {},
				startNames: [],
				reusedNames: [],
				inferredReuseNames: [],
				unhealthy: [],
			}
		: await timer.measure("app ports", () =>
				classifyCliApps(appsForDev, env.ports, {
					signal,
					// No `isPortBusy` override: the default reads every app port from
					// one snapshot rather than probing each of them separately.
					waitForServer: (url, timeout) =>
						withSignal(env.waitForServer(url, timeout), signal),
					context: { root: env.root, projectName: env.projectName },
					runtime: hasServices ? containerRuntimeForEnv(env) : undefined,
					skipContainers: !hasServices,
				}),
			);

	// Whatever is taken over below, by whichever rule: its lease follows.
	let takeover = initialTakeover(
		args.values.takeover && !isOneShot(args.values),
	);
	async function takeOver(candidates: TakeoverCandidates) {
		// Never begun once interrupted: it kills the other run's servers, and
		// an interrupted run would not start them here.
		signal.throwIfAborted();
		takeover = acceptTakeover(takeover, candidates.names);
		log.line();
		await stopRunningApps(candidates.names, env.ports, {
			root: env.root,
			apps: candidates.apps,
			runtime: hasServices ? containerRuntimeForEnv(env) : undefined,
			skipContainers: !hasServices,
		});
		hostsWarnings = await activateNamedHosts(
			namedHostsOf(env),
			{
				enabled: !args.values["no-hosts"],
				signal,
				takeover: candidates.names,
			},
			machineNamedHostsDeps,
		);
		classifiedApps = withTakenOver(classifiedApps, candidates);
	}
	// Explicit takeover precedes public URL inheritance as well as private URL acquisition.
	if (takeover.kind === "all") {
		const candidates = takeoverCandidates(classifiedApps.reusedApps, env.ports);
		if (candidates.names.length) await takeOver(candidates);
	}

	// A sibling run's server failing its health check is not worth reusing:
	// replace it through the takeover, which also reclaims its named hosts.
	// A detached run has no terminal to ask, as with `stop`.
	const [firstUnhealthy] = classifiedApps.unhealthy;
	if (firstUnhealthy) {
		const unhealthy = classifiedApps.unhealthy;
		const candidates = takeoverCandidates(
			Object.fromEntries(
				unhealthy.flatMap(({ name }) => {
					const app = classifiedApps.reusedApps[name];
					return app ? [[name, app]] : [];
				}),
			),
			env.ports,
		);
		const replaceable =
			!isOneShot(args.values) && candidates.names.length === unhealthy.length;
		const accepted =
			replaceable &&
			(unhealthy.every((app) => app.detached) ||
				(isInteractive() && (await promptUnhealthyTakeover(candidates.names))));
		if (!accepted) {
			throw new CliError(
				unhealthyAppMessage(firstUnhealthy),
				replaceable
					? ["Pass --takeover to stop it and run here instead."]
					: ["Stop the existing process or free the port."],
			);
		}
		await takeOver(candidates);
	}

	// ── Expose planning ──────────────────────────────────────────────────────
	// Never in a one-shot mode (`DevArgs.ignoredFlags`).
	if (exposeRequested(args.values)) {
		await tunnels.planExpose({
			exposeValue: exposeTargets(args.values),
			appsRequested: selectedAppNames !== undefined,
			selectedAppNames: new Set(Object.keys(appsForDev)),
			selectedServiceNames: new Set(plan.requiredServiceKeys),
			startAppNames: new Set(Object.keys(classifiedApps.startApps)),
			reusedAppNames: new Set(Object.keys(classifiedApps.reusedApps)),
		});
	}

	// The modes below exit before the takeover, so nothing is going to retry
	// the activation for them and their warnings are already final.
	if (isOneShot(args.values)) flushHostsWarnings();

	// ── One-shot modes ───────────────────────────────────────────────────────
	if (args.values.migrate) {
		env.logInfo(undefined, undefined, plan);
		log.line();
		log.success("Migrations applied successfully");
		return 0;
	}

	if (args.values.seed) {
		return reportCliSeed(
			env,
			pipeline.seed,
			prepared.seed,
			plan.requiredServiceKeys,
		);
	}

	if (args.values["up-only"]) {
		env.logInfo(undefined, undefined, plan);
		log.line();
		log.success("Containers started. Environment ready.");
		log.line();
		return 0;
	}

	// ── Dev servers ──────────────────────────────────────────────────────────
	const startableApps = Object.fromEntries(
		Object.entries(classifiedApps.startApps).filter(
			([, app]) => app.devCommand !== false,
		),
	);
	classifiedApps = {
		...classifiedApps,
		startApps: startableApps,
		startNames: Object.keys(startableApps),
	};
	// Services and no app buncargo runs: the containers are the run. It holds
	// them until Ctrl-C like any other run, rather than releasing them to the
	// idle hold the moment they are up.
	const servicesOnly =
		hasServices &&
		!Object.values(appsForDev).some((app) => app.devCommand !== false);

	// Decided before the summary and the banner, so both describe what this run
	// ends up doing rather than a reuse the takeover is about to undo.
	const running = takeoverCandidates(classifiedApps.reusedApps, env.ports);
	const offerTakeover = shouldOfferTakeover({
		decision: takeover,
		nothingToSpawn: classifiedApps.startNames.length === 0,
		candidates: running.names.length,
		pendingTunnels: tunnels.hasPendingTargets(),
		inheritsPublicUrls: tunnels.inheritsPublicUrls(),
		sharing: connect?.active === true,
	});
	const askTakeover = offerTakeover && isInteractive();
	if (askTakeover && (await promptTakeover(running.names))) {
		await takeOver(running);
	}

	flushHostsWarnings();

	// Leases before anything spawns, then the run's entry: a refused lease
	// ends this run, and the registry should never show it as starting. A
	// skipped one (an `essential: false` app, the Shopify CLI) leaves the
	// spawn set here, so the summary, the banner and the registry describe
	// the run that actually happens, and says why where it can be seen.
	// Published after the takeover has been decided: before it, the app
	// classification still describes a reuse the takeover is about to undo,
	// and `env.urls` may still hold the localhost fallback from the refused
	// first activation.
	signal.throwIfAborted();
	const claimed = await pipeline.claimApps(prepared, {
		apps: classifiedApps.startApps,
		reused: classifiedApps.reusedApps,
		attached: args.values.attach,
		leasePolicy: cliLeasePolicy({ takeover: () => takeover }),
		signal,
	});
	const leaseSkips = claimed.skipped;
	classifiedApps = {
		...classifiedApps,
		startApps: claimed.apps,
		startNames: Object.keys(claimed.apps),
	};
	const next = decideSpawn({
		startNames: classifiedApps.startNames,
		reusedNames: classifiedApps.reusedNames,
		leaseSkips: leaseSkips.length,
		servicesOnly,
		pendingTunnels: tunnels.hasPendingTargets(),
		sharing: connect?.active === true,
	});
	const [firstSkip] = leaseSkips;
	if (next === "refuse" && firstSkip) {
		throw new CliError(
			`Nothing to start: ${firstSkip.key} is in use by another run.`,
			[...describeLeaseRefusal(firstSkip), ...leaseTakeoverHints(firstSkip)],
		);
	}
	warnSkippedLeaseApps(leaseSkips);

	connect?.start(env.sessionId);

	// Deliberately not awaited, and only after the run is on disk: an app that
	// cannot read this registry has something to read the moment it updates,
	// and a GitHub round trip never sits between the user and their servers.
	void checkMenuBarAppUpdate(signal);

	logSelectedAppsSummary({
		...classifiedApps,
		skippedNames: leaseSkips.map((skip) => skip.app),
	});

	if (!exposeRequested(args.values)) {
		env.logInfo(undefined, undefined, {
			appNames: Object.keys({
				...classifiedApps.startApps,
				...classifiedApps.reusedApps,
			}),
			requiredServiceKeys: plan.requiredServiceKeys,
		});
	}

	if (next === "already-running") {
		if (overlapSeed)
			assertSeedSucceeded(
				await timer.measure("seed", () => env.runSeed({ signal })),
			);
		log.success("Selected apps are already running. Nothing to start.");
		if (running.names.length > 0 && !askTakeover) {
			log.hint("Pass --takeover to stop them and run here instead.");
		}
		return undefined;
	}

	const holds = next === "hold";
	const appsElapsed = startTimer();
	let firstSpawn = false;
	const view = openDevOutput(env, classifiedApps.startApps, {
		tui: tuiMode(args.values),
	});
	failureContext.output = view.output;
	// A service container stopping under the run: in the run's log, the TUI's
	// Overview, and on the terminal in stream mode, where events are not printed.
	// Events are not printed in stream mode, so the early ones are not repeated.
	for (const { message, problem } of earlyReports)
		view.output.event("buncargo", message, problem ? "error" : undefined);
	pipeline.notify((message, problem) => {
		const raw = problem ? formatWarn(message) : formatStep(message);
		const level = problem ? "error" : undefined;
		view.output.announce("buncargo", message, { raw, level });
	});
	// An app that falls over is often the first sign its database was removed
	// under it; say who did, once, rather than leave a refused connection.
	let lossExplained = !hasServices;
	let explaining = false;
	const explainLoss = async () => {
		if (lossExplained || explaining) return;
		explaining = true;
		try {
			const loss = await env.explainMissingContainers();
			if (!loss) return;
			lossExplained = true;
			view.output.event("buncargo", loss, "warn");
		} finally {
			explaining = false;
		}
	};

	try {
		// After every prompt and the banner, which stay in the scrollback, and
		// never for a run already interrupted.
		signal.throwIfAborted();
		view.start();
		// The TUI covers that scrollback: repeat why an app is missing, and why
		// the URLs are `localhost:port`, in its Overview (events are not
		// printed again in stream mode).
		for (const warning of printedHostsWarnings)
			view.output.event("buncargo", warning, "warn");
		for (const skip of leaseSkips)
			for (const line of leaseSkipLines(skip))
				view.output.event(skip.app, line, "warn");
		await pipeline.spawn(claimed, {
			signal,
			prepare: holds
				? async (sessionSignal) => {
						await tunnels.openOwnedTunnels(sessionSignal);
						void recordAppUrls(env, Object.keys(appsForDev));
					}
				: undefined,
			onSeedReady: () => {
				if (!holds) log.success("All servers ready");
			},
			stayOpen: holds ? waitForShutdownSignal : undefined,
			onReady: async () => {
				if (!holds) timer.record("app readiness", appsElapsed());
				timer.report();
				if (servicesOnly)
					log.success("Services ready. Press Ctrl-C to end the run.");
			},
			attach: args.values.attach,
			extraArgs: [...args.passthrough],
			output: view.output,
			waitForExit: true,
			onSignal: () => {
				// Teardown releases again and reports a failure that stays.
				void env
					.releaseRun()
					.catch((error) =>
						log.warn(
							`Could not release this run in ~/.buncargo/runs.json: ${String(error)}. Retrying as the run ends.`,
						),
					);
			},
			// A developer's other apps should not go down with one that
			// never came up; `ci` and library starts keep failing the run.
			keepOthersOnFailure: env.onAppFailure !== "stop-run",
			watch: !args.values["no-watch"],
			onAppPhase: async (name, life, previous) => {
				const spawned = life.pid !== undefined && life.pid !== previous.pid;
				if (spawned) {
					options.runningApps.add(name);
					if (!firstSpawn) {
						firstSpawn = true;
						timer.record("entry to first app spawn", timer.elapsedMs());
					}
				}
				const failure = life.end?.failure;
				const newFailure = failure !== previous.end?.failure;
				// Never came up while the rest goes on: recorded before the
				// registry says it failed, which `dev --detach` waits on.
				const sparedFailure =
					newFailure &&
					failure?.kind === "not-ready" &&
					life.standing !== "essential";
				if (sparedFailure)
					detached?.recordDetachedReport(env.root, (report) => ({
						...report,
						failures: [
							...report.failures,
							describeAppFailure({
								app: name,
								reason: failure.message,
								tail: view.output.tail(name),
								setupHints: failureContext.setupHints,
							}),
						],
					}));
				// A non-zero code is the app falling over, often the first
				// sign its database was removed under it.
				const exit = life.end?.exit;
				if (life.phase === "down" && exit !== previous.end?.exit) {
					options.runningApps.delete(name);
					if (exit && exit.code !== null && exit.code !== 0) void explainLoss();
				}
				// Activation claimed the first spawn's route; a restart claims
				// it again in case a takeover moved it away and its run ended.
				// Done before the new process spawns: its config reads its URL
				// from the registry as it loads (`getEnvVar`).
				if (life.phase === "restarting" && previous.phase !== "restarting") {
					const warning = await reclaimAppRoute(env, name);
					if (warning) view.output.event(name, warning, "warn");
				}
			},
			onAfterWave1: async (signal) => {
				await timer.measure("tunnels", () => tunnels.openOwnedTunnels(signal));
				void recordAppUrls(env, Object.keys(appsForDev));
			},
			onCapture: async (app, captured) => {
				void recordRunCapture(env, app, captured);
			},
			// Nothing to wait for without --expose, so needsPublicUrls apps
			// join wave 1 and get health-checked like everything else.
			deferPublicUrlApps: exposeRequested(args.values),
		});
		return undefined;
	} finally {
		// First, so teardown's messages land on the user's own screen.
		await view.stop();
	}
}

/**
 * The apps `--apps` or `--profile` select, `undefined` for every app. argv
 * only ever yields plain strings: every `--apps` name is checked against the
 * config's app keys here, before planning trusts them.
 */
function selectDevApps<TApps extends Record<string, AppConfig>>(
	env: Pick<
		DevEnvironment<Record<string, ServiceConfig>, TApps>,
		"apps" | "profiles"
	>,
	args: DevArgs,
): Extract<keyof TApps, string>[] | undefined {
	const names = requestedApps(args);
	if (names === undefined) return selectProfileApps(env, args.values.profile);
	assertConfiguredApps(Object.keys(env.apps), names);
	return names as Extract<keyof TApps, string>[];
}

/**
 * The apps `--profile` selects, or the `default` profile's when neither it nor
 * `--apps` is given. `undefined` means every app, as before profiles existed.
 */
export function selectProfileApps<TApps extends Record<string, AppConfig>>(
	env: Pick<DevEnvironment<Record<string, ServiceConfig>, TApps>, "profiles">,
	name: string | undefined,
): Extract<keyof TApps, string>[] | undefined {
	const profiles = env.profiles ?? {};
	const profile = profiles[name ?? "default"];
	// Validation checked these against the applied config, which includes the
	// apps integrations add, so every name is an app key at runtime.
	if (profile) return [...profile.apps] as Extract<keyof TApps, string>[];
	if (name === undefined) return undefined;

	const available = Object.keys(profiles);
	throw new CliError(
		`Unknown profile "${name}".`,
		available.length > 0
			? [`Available profiles: ${available.join(", ")}`]
			: ["Add one to your dev config: profiles: { full: { apps: [...] } }"],
	);
}

/**
 * `--seed` forces the seed in preparation, so an explicit seed request
 * ignores `seed.check` and "not needed" can only mean the selection left out
 * its services. Exits 1 on failure, like every other flow.
 */
function reportCliSeed(
	env: Pick<AnyDevEnvironment, "services" | "apps">,
	seedConfig: EnvironmentInternals["seed"],
	seed: PreparedSeed,
	selectedServices: readonly string[],
): number {
	const outcome: SeedOutcome =
		seed.kind === "ran" ? seed.outcome : { status: "not-needed" };

	return typedSwitch(outcome, "status", {
		"not-configured": () => {
			throw new CliError("No seed command is configured.", [
				"Add a seed block to your dev config:",
				"  seed: { command: 'bun run run:seeder' }",
			]);
		},
		"not-needed": () => {
			throw (
				seedSelectionError(seedConfig, selectedServices, env) ??
				new CliError("The seed did not run for this selection.")
			);
		},
		// The run's failure block shows the seed's last lines.
		failed: (failed) => {
			throw new SeedFailedError(failed);
		},
		succeeded: () => {
			log.line();
			log.success("Seeding complete");
			return 0;
		},
	});
}
