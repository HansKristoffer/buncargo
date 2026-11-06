import { execSync } from "node:child_process";
import { startTimer, typedSwitch } from "hanzio";
import {
	containerRuntimeForEnv,
	replaceStaleStacksOn,
} from "../container-runtime";
import { describeLeaseRefusal, type SkippedLeaseApp } from "../core/app-leases";
import { withSignal } from "../core/deadline";
import { removeHostRoutes, routesDownRemoves } from "../core/hosts";
import { releaseLeases } from "../core/leases";
import { askConfirm, PromptInterruptedError } from "../core/prompt";
import {
	appRowEvents,
	flushRunPatches,
	publishCurrentRun,
	recordAppUrls,
	recordRunCapture,
} from "../core/run-publish";
import { detachedRunMode, isCI } from "../core/runtime-flags";
import { ensureSecretsSession } from "../core/secrets/infisical";
import { joinColoredNames } from "../core/style";
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
import { ensureWatchdog } from "../core/watchdog";
import { WATCHDOG_IDLE_TIMEOUT_MS } from "../core/watchdog-constants";
import {
	assertSeedSucceeded,
	SeedFailedError,
	seedCanOverlap,
} from "../environment/seed-startup";
import { startServerSession } from "../environment/server-session";
import { serverReadyTimeout } from "../environment/servers";
import { planStart } from "../planning";
import type {
	AnyDevEnvironment,
	AppConfig,
	CliOptions,
	DevEnvironment,
	ServiceConfig,
} from "../types";
import { checkMenuBarAppUpdate, offerMenuBarApp } from "./bar-offer";
import {
	checkFailureError,
	describeCheckFailures,
	isWarning,
	runChecks,
} from "./checks";
import { allChecks } from "./core-checks";
import { createDevConnect, type DevConnect } from "./dev-connect";
import {
	type DevCliArgs,
	destructiveModeGate,
	exitOnDevArgErrors,
	parseDevArgs,
	printDevHelp,
} from "./dev-flags";
import {
	activateNamedHosts,
	reclaimAppRoute,
	releaseNamedHosts,
} from "./dev-hosts";
import { listenForInterrupts } from "./dev-interrupts";
import {
	acquireAppLeases,
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
	type TunnelApi,
} from "./dev-tunnels";
import { CliError } from "./errors";
import * as log from "./log";
import {
	classifyCliApps,
	parseRequiredCommaSeparatedFlag,
	type UnhealthyApp,
	unhealthyAppMessage,
} from "./port-reuse";
import { runPreflight } from "./preflight";
import {
	type DevFailureContext,
	describeAppFailure,
	describeDevFailure,
	formatRunFailure,
} from "./run-failure";
import { configSecretScopes } from "./secrets-scopes";
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
function resolveIdleTimeout(args: DevCliArgs): number | false | undefined {
	if (args.keepContainers) return false;
	// Before the one-shot default: `--up-only --watchdog-timeout=5` is someone
	// asking for a hold in as many words, and silently ignoring it would leave
	// the containers up forever.
	if (args.watchdogTimeoutMinutes !== undefined)
		return args.watchdogTimeoutMinutes * 60_000;
	if (args.oneShot) return false;
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
 * Run the CLI for a dev environment.
 */
export async function runCli<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	options: CliOptions & {
		/** Test-only tunnel substitutes. */
		cliTestTunnel?: TunnelApi;
		timer?: PhaseTimer;
	} = {},
): Promise<void> {
	const {
		args: rawArgs = process.argv.slice(2),
		watchdog = true,
		cliTestTunnel,
	} = options;
	const args = parseDevArgs(rawArgs);

	if (args.help) {
		printDevHelp();
		process.exit(0);
	}

	exitOnDevArgErrors(args);
	for (const warning of args.ignoredFlags) log.warn(warning);

	if (args.detach) {
		const { DETACH_TIMEOUT_MS, runDetached } = await import("./dev-detach");
		const plan = planStart(env.apps, env.services, {
			onlyApps: selectDevApps(env, args),
		});
		process.exit(
			await runDetached({
				root: env.root,
				keep: args.keep,
				expectApps: Object.values(plan.apps).some(
					(app) => app.devCommand !== false,
				),
				argv: process.argv,
				timeoutMs: DETACH_TIMEOUT_MS,
			}),
		);
	}

	// The first SIGINT/SIGTERM/SIGHUP aborts the run with `RunInterrupted`, a
	// second exits at once (`dev-interrupts.ts`).
	const interrupts = listenForInterrupts({
		clock: () => performance.now(),
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
	const tunnels = createTunnelCoordinator(
		env,
		cliTestTunnel ?? {
			resolveExposeTargets,
			startPublicTunnels,
			stopPublicTunnels,
		},
		{ exposeRequested: args.exposeRequested, signal: controller.signal },
	);

	const timer =
		options.timer ??
		(args.timing
			? createPhaseTimer({ json: args.timingJson })
			: createNoopPhaseTimer());

	let connect: DevConnect | undefined;
	// Every path ends here once, whichever reaches it first: the one-shot
	// modes, "nothing to start", the end of the run, and a failure.
	let tearingDown: Promise<void> | undefined;
	const teardownOnce = () => {
		tearingDown ??= teardown(env, tunnels, connect);
		return tearingDown;
	};
	let exitCode: DevFlowExit;
	const failureContext: DevFailureContext = { setupHints: [] };
	try {
		if (!args.oneShot && !args.down && !args.reset)
			connect = createDevConnect();
		exitCode = await runDevFlow(env, args, tunnels, {
			watchdog,
			connect,
			timer,
			signal: controller.signal,
			failureContext,
			teardown: teardownOnce,
		});
	} catch (error) {
		controller.abort(error);
		timer.report();
		// The prompt re-raises SIGINT, which arrives after this.
		if (error instanceof PromptInterruptedError) interrupts.promptInterrupted();
		const failure =
			interrupts.exitCode() === undefined
				? describeDevFailure(error, failureContext)
				: undefined;
		if (failure && detachedRunMode() !== undefined) {
			const { recordDetachedReport } = await import("./dev-detach");
			recordDetachedReport(env.root, (report) => ({
				...report,
				failures: [...report.failures, failure],
			}));
		}
		try {
			await teardownOnce();
		} finally {
			// Last, after teardown's own messages: agents read `dev | tail`.
			if (failure) {
				const { message, hints } = formatRunFailure(failure);
				log.errorNow(message, hints);
			}
		}
		process.exit(interrupts.exitCode() ?? 1);
	} finally {
		interrupts.dispose();
	}

	// 128 + the signal however an interrupted run ended: one that only held
	// services or tunnels returns normally from the signal.
	const interrupted = interrupts.exitCode();
	if (interrupted !== undefined) process.exit(interrupted);
	if (exitCode !== undefined) {
		process.exit(exitCode);
	}
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
		const hosts = releaseNamedHosts(env);
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
	args: DevCliArgs,
): Promise<void> {
	const gate = destructiveModeGate(args, {
		interactive: isInteractive(),
		ci: isCI(),
	});
	if (gate === "run") return;

	const what = args.reset
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

/**
 * The dev command flow. Returns an exit code for the one-shot modes and
 * `undefined` when the caller should simply return.
 *
 * Every exit path tears down tunnels, host routes and the terminal first;
 * failures throw `CliError` and are reported by `runCli`.
 */
async function runDevFlow<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	args: DevCliArgs,
	tunnels: DevTunnelCoordinator<TServices, TApps>,
	options: {
		watchdog: boolean;
		timer: PhaseTimer;
		signal: AbortSignal;
		connect?: DevConnect;
		/** Filled in as the run goes, for the block a failure ends on. */
		failureContext: DevFailureContext;
		/** The run's one teardown; every path calls it, it runs once. */
		teardown: () => Promise<void>;
	},
): Promise<DevFlowExit> {
	const { timer, signal, connect, failureContext, teardown } = options;
	// Loaded only in the background run that reports to `dev --detach`.
	const detached =
		detachedRunMode() !== undefined ? await import("./dev-detach") : undefined;
	async function exitWith(code: number): Promise<number> {
		// The one-shot modes end here, and `--up-only` is exactly the kind of
		// run someone times.
		timer.report();
		await teardown();
		return code;
	}

	await confirmDestructiveMode(env, args);

	if (args.down && args.all) {
		const { stopAllBuncargoEnvironments } = await import("./commands/inspect");
		await stopAllBuncargoEnvironments();
		return exitWith(0);
	}

	if (args.down || args.reset) {
		env.logInfo();
		await removeHostRoutes(routesDownRemoves(env.root));
		await env.stop({ removeVolumes: args.reset, signal });
		return exitWith(0);
	}

	// ── App selection ────────────────────────────────────────────────────────
	const selectedAppNames = selectDevApps(env, args);

	const plan = planStart(env.apps, env.services, {
		onlyApps: selectedAppNames,
	});
	const appsForDev = plan.apps;
	validateDevStart(env, args, appsForDev, plan.requiredServiceKeys);

	// Fired now, awaited before named hosts and the claim: an expired
	// Infisical session stops the run before any container or app starts, with
	// the login to run, instead of hanging inside every app's own loader. The
	// selected apps' scopes and the config-level one (migrations, the seed).
	// It overlaps the checks and preflight; `start()` and the apps reuse its
	// token.
	const secretsSession = args.upOnly
		? Promise.resolve()
		: ensureSecretsSession(
				configSecretScopes({ secrets: env.secrets, apps: appsForDev }).map(
					({ scope }) => scope,
				),
				{ signal },
			);
	void secretsSession.catch(() => {});

	// Before anything is started: a missing generated file fails here with its
	// fix, instead of deep inside whichever app imports it first. Only the fast
	// checks: this runs on every start in every worktree.
	if (!args.oneShot) {
		const anyEnv = env as unknown as AnyDevEnvironment;
		const checks = allChecks(anyEnv).filter((check) => check.fast !== false);
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
			runPreflight(anyEnv, Object.keys(appsForDev)),
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
	if (args.replaceStale) {
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
	const overlapSeed =
		!args.oneShot &&
		Object.keys(appsForDev).length > 0 &&
		seedCanOverlap(env.seed, env.services, plan.requiredServiceKeys);

	await timer.measure("secrets session", () => secretsSession);

	// ── Containers ───────────────────────────────────────────────────────────
	// Held rather than printed: a run that takes over another one activates a
	// second time, and only that attempt describes the URLs the banner prints.
	let hostsWarnings = args.oneShot
		? []
		: await timer.measure("hosts", () =>
				activateNamedHosts(env, { enabled: args.hosts, signal }),
			);
	// After named hosts, which owns the first-run prompt slot on a fresh
	// machine, and before the containers, so a question cannot land in the
	// middle of startup output.
	if (!args.oneShot) {
		signal.throwIfAborted();
		await offerMenuBarApp();
	}
	// Kept for the TUI, which covers the scrollback they were printed in.
	const printedHostsWarnings: string[] = [];
	const flushHostsWarnings = (): void => {
		for (const warning of hostsWarnings) log.warn(warning);
		printedHostsWarnings.push(...hostsWarnings);
		hostsWarnings = [];
	};
	// Claimed here rather than left to `start()`, because only the CLI knows
	// the hold its flags ask for; `start()` claims too, and keeps this one.
	// Claimed whether or not a watchdog is wanted: the claim is what says the
	// containers are somebody's, and the registry has to say so either way.
	signal.throwIfAborted();
	if (hasServices)
		await env.claimRun({
			idleTimeoutMs: resolveIdleTimeout(args),
			defaultIdleTimeoutMs: WATCHDOG_IDLE_TIMEOUT_MS,
		});
	await env.start({
		watchdog: options.watchdog,
		signal,
		startServers: false,
		wait: true,
		skipSeed: args.seed || args.migrate || args.upOnly || overlapSeed,
		// `--seed` runs the seed next: fetch its scope beside the containers.
		prefetchSeed: overlapSeed || args.seed,
		prepare: args.upOnly ? "containers" : args.migrate ? "migrate" : "all",
		onPhase: timer.record,
		skipEnvironmentLog: true,
		onlyApps: selectedAppNames,
		autoStartDocker: args.dockerAutostart ? undefined : false,
		// The dev servers below run their dev commands in CI too.
		productionBuild: false,
	});

	let classifiedApps = args.oneShot
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
	let takeover = initialTakeover(args.takeover);
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
		hostsWarnings = await activateNamedHosts(env, {
			enabled: args.hosts,
			signal,
			takeover: candidates.names,
		});
		classifiedApps = {
			startApps: { ...classifiedApps.startApps, ...candidates.apps },
			startNames: [...classifiedApps.startNames, ...candidates.names],
			reusedApps: Object.fromEntries(
				Object.entries(classifiedApps.reusedApps).filter(
					([name]) => !candidates.names.includes(name),
				),
			),
			reusedNames: classifiedApps.reusedNames.filter(
				(name) => !candidates.names.includes(name),
			),
			inferredReuseNames: classifiedApps.inferredReuseNames.filter(
				(name) => !candidates.names.includes(name),
			),
			unhealthy: classifiedApps.unhealthy.filter(
				(app) => !candidates.names.includes(app.name),
			),
		};
	}
	// Explicit takeover precedes public URL inheritance as well as private URL acquisition.
	if (takeover.kind === "all") {
		const candidates = takeoverCandidates(classifiedApps.reusedApps, env.ports);
		if (candidates.names.length) await takeOver(candidates);
	}

	// A sibling run's server failing its health check is not worth reusing:
	// replace it through the takeover, which also reclaims its named hosts.
	// A detached run has no terminal to ask, as with `stop`.
	if (classifiedApps.unhealthy.length > 0) {
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
			!args.oneShot && candidates.names.length === unhealthy.length;
		const accepted =
			replaceable &&
			(unhealthy.every((app) => app.detached) ||
				(isInteractive() && (await promptUnhealthyTakeover(candidates.names))));
		if (!accepted) {
			throw new CliError(
				unhealthyAppMessage(unhealthy[0] as UnhealthyApp),
				replaceable
					? ["Pass --takeover to stop it and run here instead."]
					: ["Stop the existing process or free the port."],
			);
		}
		await takeOver(candidates);
	}

	// ── Expose planning ──────────────────────────────────────────────────────
	// Never in a one-shot mode (`DevCliArgs.ignoredFlags`).
	if (args.exposeRequested) {
		await tunnels.planExpose({
			exposeValue: args.exposeValue,
			appsRequested: selectedAppNames !== undefined,
			selectedAppNames: new Set(Object.keys(appsForDev)),
			selectedServiceNames: new Set(plan.requiredServiceKeys),
			startAppNames: new Set(Object.keys(classifiedApps.startApps)),
			reusedAppNames: new Set(Object.keys(classifiedApps.reusedApps)),
		});
	}

	// The modes below exit before the takeover, so nothing is going to retry
	// the activation for them and their warnings are already final.
	if (args.oneShot) flushHostsWarnings();

	// ── One-shot modes ───────────────────────────────────────────────────────
	if (args.migrate) {
		env.logInfo(undefined, undefined, plan);
		log.line();
		log.success("Migrations applied successfully");
		return exitWith(0);
	}

	if (args.seed) {
		return exitWith(await runCliSeed(env, plan.requiredServiceKeys, signal));
	}

	if (args.upOnly) {
		env.logInfo(undefined, undefined, plan);
		log.line();
		log.success("Containers started. Environment ready.");
		log.line();
		return exitWith(0);
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
	let nothingToSpawn = classifiedApps.startNames.length === 0;
	const running = takeoverCandidates(classifiedApps.reusedApps, env.ports);
	const offerTakeover = shouldOfferTakeover({
		decision: takeover,
		nothingToSpawn,
		candidates: running.names.length,
		pendingTunnels: tunnels.hasPendingTargets(),
		inheritsPublicUrls: tunnels.inheritsPublicUrls(),
		sharing: connect?.active === true,
	});
	const askTakeover = offerTakeover && isInteractive();
	if (askTakeover && (await promptTakeover(running.names))) {
		await takeOver(running);
		nothingToSpawn = false;
	}

	flushHostsWarnings();

	// Leases before anything spawns and before the run is published: a refused
	// lease ends this run, and the registry should never show it as starting.
	// A skipped one (an `essential: false` app, the Shopify CLI) leaves the
	// spawn set here, so the summary, the banner and the registry describe the
	// run that actually happens, and says why where it can be seen.
	const { skipped: leaseSkips } = await acquireAppLeases(
		env,
		classifiedApps.startApps,
		{ signal, takeover },
	);
	if (leaseSkips.length > 0) {
		const skippedNames = new Set(leaseSkips.map((skip) => skip.app));
		const startApps = Object.fromEntries(
			Object.entries(classifiedApps.startApps).filter(
				([name]) => !skippedNames.has(name),
			),
		);
		classifiedApps = {
			...classifiedApps,
			startApps,
			startNames: Object.keys(startApps),
		};
		nothingToSpawn = classifiedApps.startNames.length === 0;
		if (
			nothingToSpawn &&
			classifiedApps.reusedNames.length === 0 &&
			!tunnels.hasPendingTargets() &&
			!connect?.active
		) {
			const [skip] = leaseSkips as [SkippedLeaseApp];
			throw new CliError(
				`Nothing to start: ${skip.key} is in use by another run.`,
				[...describeLeaseRefusal(skip), ...leaseTakeoverHints(skip)],
			);
		}
		warnSkippedLeaseApps(leaseSkips);
	}

	// Published here, after the takeover has been decided: before it, the app
	// classification still describes a reuse the takeover is about to undo, and
	// `env.urls` may still hold the localhost fallback from the refused first
	// activation. It lands on the entry the environment claimed, by session.
	signal.throwIfAborted();
	await publishCurrentRun(env, {
		apps: { ...classifiedApps.startApps, ...classifiedApps.reusedApps },
		reusedNames: classifiedApps.reusedNames,
		serviceNames: plan.requiredServiceKeys,
		attached: args.attach,
	});

	connect?.start(env.sessionId);

	// Deliberately not awaited, and only after the run is on disk: an app that
	// cannot read this registry has something to read the moment it updates,
	// and a GitHub round trip never sits between the user and their servers.
	void checkMenuBarAppUpdate();

	logSelectedAppsSummary({
		...classifiedApps,
		skippedNames: leaseSkips.map((skip) => skip.app),
	});

	if (!args.exposeRequested) {
		env.logInfo(undefined, undefined, {
			appNames: Object.keys({
				...classifiedApps.startApps,
				...classifiedApps.reusedApps,
			}),
			requiredServiceKeys: plan.requiredServiceKeys,
		});
	}

	if (
		nothingToSpawn &&
		!servicesOnly &&
		!tunnels.hasPendingTargets() &&
		!connect?.active
	) {
		if (overlapSeed)
			assertSeedSucceeded(
				await timer.measure("seed", () => env.runSeed({ signal })),
			);
		timer.report();
		log.success("Selected apps are already running. Nothing to start.");
		if (running.names.length > 0 && !askTakeover) {
			log.hint("Pass --takeover to stop them and run here instead.");
		}
		await teardown();
		return undefined;
	}

	const appsElapsed = startTimer();
	let firstSpawn = false;
	const spawned = new Set<string>();
	const view = openDevOutput(env, classifiedApps.startApps, { tui: args.tui });
	failureContext.output = view.output;
	// The app rows, recorded by the rule a library `start()` uses too.
	const rows = appRowEvents(env);
	// A service container stopping under the run: in the run's log, the TUI's
	// Overview, and on the terminal in stream mode, where events are not printed.
	env.reportServiceChanges((message, problem) => {
		view.output.event("buncargo", message, problem ? "error" : undefined);
		if (!view.tui) (problem ? log.warn : log.info)(message);
	});
	// An app that falls over is often the first sign its database was removed
	// under it; say who did, once, rather than leave a refused connection.
	let lossExplained = !hasServices;
	const explainLoss = () => {
		if (lossExplained) return;
		const loss = env.explainMissingContainers();
		if (!loss) return;
		lossExplained = true;
		view.output.event("buncargo", loss, "warn");
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
		await startServerSession(
			{
				root: env.root,
				prepare: nothingToSpawn
					? async (sessionSignal) => {
							await tunnels.openOwnedTunnels(sessionSignal);
							void recordAppUrls(env, Object.keys(appsForDev));
						}
					: undefined,
				onSeedReady: () => {
					if (!nothingToSpawn) log.success("All servers ready");
				},
				ports: env.ports as Record<string, number>,
				appEnv: (name) =>
					env.buildAppEnvVars(name as Extract<keyof TApps, string>),
				runHook: async (phase, hookSignal) => {
					await env.runServerHook?.(phase, hookSignal);
				},
				waitForHealth: (apps, healthSignal, onAppReady) =>
					env.waitForServers({
						onlyApps: Object.keys(apps) as Extract<keyof TApps, string>[],
						expandRequired: false,
						timeout: serverReadyTimeout(),
						logReady: !overlapSeed,
						signal: healthSignal,
						onAppReady,
					}),
				recordCapture: (app, captured) => env.recordCapture(app, captured),
				afterWave: () => {
					for (const path of env.renderGeneratedFiles())
						log.done(`Updated ${path}`);
				},
			},
			classifiedApps.startApps,
			{
				signal,
				seed: overlapSeed
					? (seedSignal) =>
							timer.measure("seed", () =>
								// Through the run's output, so stream mode and the TUI
								// both show it and write it to the run's `seed.log`.
								env.runSeed({
									signal: seedSignal,
									onOutputLine: (line) => view.output.line("seed", line),
								}),
							)
					: undefined,
				stayOpen: nothingToSpawn ? waitForShutdownSignal : undefined,
				projectName: env.projectName,
				runtime: hasServices ? containerRuntimeForEnv(env) : undefined,
				skipContainers: !hasServices,
				onPhase: timer.record,
				onReady: async () => {
					if (!nothingToSpawn) timer.record("app readiness", appsElapsed());
					timer.report();
					// `start()` ensures the watchdog only for a run with containers,
					// but the watchdog is also what lists live runs to BuncargoBar
					// on the tailnet, and it stays while a run is live. Once the
					// apps are up and not awaited, so startup pays nothing; quiet,
					// because the TUI may own the screen.
					if (!hasServices && options.watchdog)
						void ensureWatchdog({ verbose: false }).catch(() => {});
					if (servicesOnly)
						log.success("Services ready. Press Ctrl-C to end the run.");
				},
				attach: args.attach,
				extraArgs: args.passthrough,
				output: view.output,
				waitForExit: true,
				onSignal: () => {
					void env.releaseRun();
				},
				// Ready as each app comes up, not when its whole wave has; a
				// restart (`r`, `buncargo restart`, a watch, a capture's
				// `restartOn`) says `starting` before its new process spawns.
				...rows,
				// A developer's other apps should not go down with one that
				// never came up; `ci` and library starts keep failing the run.
				keepOthersOnFailure: env.onAppFailure !== "stop-run",
				watch: args.watch,
				onAppFailed: (name, error) => {
					// Before the registry says it failed, which `dev --detach` waits on.
					detached?.recordDetachedReport(env.root, (report) => ({
						...report,
						failures: [
							...report.failures,
							describeAppFailure({
								app: name,
								reason: error.message,
								tail: view.output.tail(name),
								setupHints: failureContext.setupHints,
							}),
						],
					}));
					rows.onAppFailed(name, error);
				},
				onAppSpawned: (name, pid, attached) => {
					if (!firstSpawn) {
						firstSpawn = true;
						timer.record("entry to first app spawn", timer.elapsedMs());
					}
					rows.onAppSpawned(name, pid, attached);
					// Activation claimed the first spawn's route; a restart claims it
					// again in case a takeover moved it away and its run ended.
					if (spawned.has(name)) void reclaimAppRoute(env, name);
					spawned.add(name);
				},
				// A non-zero code is the app falling over: the run's end for an
				// essential app that was up, a parked row for one that never came
				// up while the others are spared.
				onAppExit: (name, code, signal, state) => {
					if (code !== null && code !== 0) explainLoss();
					rows.onAppExit(name, code, signal, state);
				},
				onAfterWave1: async (signal) => {
					await timer.measure("tunnels", () =>
						tunnels.openOwnedTunnels(signal),
					);
					void recordAppUrls(env, Object.keys(appsForDev));
				},
				onCapture: async (app, captured) => {
					void recordRunCapture(env, app, captured);
				},
				// Nothing to wait for without --expose, so needsPublicUrls apps
				// join wave 1 and get health-checked like everything else.
				deferPublicUrlApps: args.exposeRequested,
			},
		);
		return undefined;
	} finally {
		// First, so teardown's messages land on the user's own screen.
		await view.stop();
		await teardown();
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
	args: DevCliArgs,
): Extract<keyof TApps, string>[] | undefined {
	const profile = selectProfileApps(env, args.profile);
	if (!args.appsRequested) return profile;
	const names = parseRequiredCommaSeparatedFlag("--apps", args.appsValue);
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
 * `--seed` runs the environment's seed path with `force`, so an explicit seed
 * request ignores `seed.check` and "not needed" can only mean the selection
 * left out its services. Exits 1 on failure, like every other flow.
 */
async function runCliSeed<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	selectedServices: readonly string[],
	signal?: AbortSignal,
): Promise<number> {
	const outcome = await env.runSeed({ force: true, signal });

	return typedSwitch(outcome, "status", {
		"not-configured": () => {
			throw new CliError("No seed command is configured.", [
				"Add a seed block to your dev config:",
				"  seed: { command: 'bun run run:seeder' }",
			]);
		},
		"not-needed": () => {
			throw (
				seedSelectionError(env.seed, selectedServices, env) ??
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
