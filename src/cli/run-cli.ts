import { execSync } from "node:child_process";
import { containerRuntimeForEnv } from "../container-runtime";
import { withSignal } from "../core/deadline";
import { removeHostRoutes } from "../core/hosts";
import { releaseLeases } from "../core/leases";
import { isDeliberateExit } from "../core/process";
import { askConfirm } from "../core/prompt";
import { isCI } from "../core/runtime-flags";
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
import { WATCHDOG_IDLE_TIMEOUT_MS } from "../core/watchdog-constants";
import {
	assertSeedSucceeded,
	seedCanOverlap,
} from "../environment/seed-startup";
import { startServerSession } from "../environment/server-session";
import { environmentStartPlan } from "../environment/start-plan";
import { resolveSelectedApps } from "../planning";
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
import { activateNamedHosts, releaseNamedHosts } from "./dev-hosts";
import {
	acquireAppLeases,
	describeLeaseRefusal,
	leaseSkipLines,
	leaseTakeoverHints,
	type SkippedLeaseApp,
	warnSkippedLeaseApps,
} from "./dev-leases";
import { openDevOutput } from "./dev-output";
import {
	createTunnelCoordinator,
	type DevTunnelCoordinator,
	type TunnelApi,
} from "./dev-tunnels";
import { CliError, toCliError } from "./errors";
import * as log from "./log";
import { classifyCliApps, parseRequiredCommaSeparatedFlag } from "./port-reuse";
import { runPreflight } from "./preflight";
import {
	flushRunPatches,
	markApps,
	publishCurrentRun,
	recordAppSpawn,
	recordAppUrls,
	recordRunCapture,
} from "./run-publish";
import {
	isInteractive,
	promptTakeover,
	stopRunningApps,
	type TakeoverCandidates,
	takeoverCandidates,
} from "./takeover";
import { validateDevStart } from "./validate-dev-start";

export { getFlagValue, hasFlag, splitCliArgs } from "./flags";

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

function reportCliError(error: CliError): void {
	log.error(error.message);
	for (const item of error.hints) {
		log.hint(item);
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

	if (args.detach) {
		const { runDetached } = await import("./dev-detach");
		process.exit(
			await runDetached({
				root: env.root,
				expectApps: Object.keys(env.apps).length > 0,
			}),
		);
	}

	const controller = new AbortController();
	let interruptCode: number | undefined;
	const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
	const listeners = Object.entries(signals).map(([signal, code]) => {
		const listener = () => {
			interruptCode = code;
			controller.abort(new Error("Startup interrupted"));
		};
		process.on(signal, listener);
		return { signal, listener };
	});
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
	let exitCode: DevFlowExit;
	try {
		if (!args.oneShot && !args.down && !args.reset)
			connect = createDevConnect();
		exitCode = await runDevFlow(env, args, tunnels, {
			watchdog,
			connect,
			timer,
			signal: controller.signal,
		});
	} catch (error) {
		controller.abort(error);
		timer.report();
		if (interruptCode === undefined) reportCliError(toCliError(error));
		await teardown(env, tunnels, connect);
		process.exit(interruptCode ?? 1);
	} finally {
		for (const { signal, listener } of listeners) process.off(signal, listener);
	}

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
		const results = await Promise.allSettled([
			tunnels.stop(),
			connect?.stop(),
			releaseNamedHosts(env),
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
		: "--down --all stops every buncargo environment on this machine, including other checkouts' runs.";
	if (gate === "refuse") {
		throw new CliError(`${what} Refusing without a terminal.`, [
			"Pass --yes if that is really what you want.",
		]);
	}
	if (!(await askConfirm([`  ${what}`, "  Continue? [y/N]"])))
		throw new CliError("Cancelled.");
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
	},
): Promise<DevFlowExit> {
	const { timer, signal, connect } = options;
	async function exitWith(code: number): Promise<number> {
		// The one-shot modes end here, and `--up-only` is exactly the kind of
		// run someone times.
		timer.report();
		await teardown(env, tunnels, connect);
		return code;
	}

	await confirmDestructiveMode(env, args);

	if (args.down && args.all) {
		const { stopAllBuncargoEnvironments } = await import("./commands/inspect");
		await stopAllBuncargoEnvironments();
		return 0;
	}

	if (args.down || args.reset) {
		env.logInfo();
		await tunnels.stop();
		await removeHostRoutes((route) => route.root === env.root);
		await env.stop({ removeVolumes: args.reset, signal });
		restoreTerminal();
		return 0;
	}

	// ── App selection ────────────────────────────────────────────────────────
	// argv only ever yields plain strings. `resolveSelectedApps` drops names that
	// are not configured apps and the check below fails when nothing is left, so
	// this is the single place the CLI crosses into the config's app keys.
	let selectedAppNames: Extract<keyof TApps, string>[] | undefined =
		selectProfileApps(env, args.profile);
	let appsForDev: Record<string, AppConfig> = resolveSelectedApps(
		env.apps,
		selectedAppNames,
	).apps;
	if (args.appsRequested) {
		selectedAppNames = parseRequiredCommaSeparatedFlag(
			"--apps",
			args.appsValue,
		) as Extract<keyof TApps, string>[];
		appsForDev = resolveSelectedApps(env.apps, selectedAppNames).apps;
		if (Object.keys(appsForDev).length === 0) {
			throw new CliError("Flag --apps requires at least one valid app name.");
		}
	}

	const plan = environmentStartPlan(env, selectedAppNames);
	validateDevStart(env, args, appsForDev, plan.requiredServiceKeys);

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
		for (const line of describeCheckFailures(failed.filter(isWarning))) {
			log.warn(line);
		}
		const errors = failed.filter((result) => !isWarning(result));
		if (errors.length > 0) throw checkFailureError(errors);
		await timer.measure("preflight", () =>
			runPreflight(anyEnv, Object.keys(appsForDev)),
		);
	}
	connect?.plan(appsForDev, plan.requiredServiceKeys, env.services);
	if (connect && !connect.active)
		log.info("No selected endpoints to share through frp.");
	if (env.prepareStartAsync)
		await env.prepareStartAsync(selectedAppNames, undefined, signal);
	else env.prepareStart?.(selectedAppNames);
	const hasServices = plan.requiredServiceKeys.length > 0;
	const overlapSeed =
		!args.oneShot &&
		Object.keys(appsForDev).length > 0 &&
		seedCanOverlap(env.seed, env.services, plan.requiredServiceKeys);

	// ── Containers ───────────────────────────────────────────────────────────
	// Held rather than printed: a run that takes over another one activates a
	// second time, and the failure this first attempt reports - the other run
	// still owning the hostnames - is exactly what the takeover undoes.
	let hostsWarnings = args.oneShot
		? []
		: await timer.measure("hosts", () =>
				activateNamedHosts(env, { enabled: args.hosts, signal }),
			);
	// After named hosts, which owns the first-run prompt slot on a fresh
	// machine, and before the containers, so a question cannot land in the
	// middle of startup output.
	if (!args.oneShot) await offerMenuBarApp();
	const flushHostsWarnings = (): void => {
		for (const warning of hostsWarnings) log.warn(warning);
		hostsWarnings = [];
	};
	// Claimed here rather than left to `start()`, because only the CLI knows
	// the hold its flags ask for; `start()` claims too, and keeps this one.
	// Claimed whether or not a watchdog is wanted: the claim is what says the
	// containers are somebody's, and the registry has to say so either way.
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
		prefetchSeed: overlapSeed,
		prepare: args.upOnly ? "containers" : args.migrate ? "migrate" : "all",
		onPhase: timer.record,
		skipEnvironmentLog: true,
		onlyApps: selectedAppNames,
		autoStartDocker: args.dockerAutostart ? undefined : false,
	});

	let classifiedApps =
		args.oneShot && !args.exposeRequested
			? {
					startApps: {},
					reusedApps: {},
					startNames: [],
					reusedNames: [],
					inferredReuseNames: [],
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

	async function takeOver(candidates: TakeoverCandidates) {
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
		};
	}
	// Explicit takeover precedes public URL inheritance as well as private URL acquisition.
	if (args.takeover && !args.oneShot) {
		const candidates = takeoverCandidates(classifiedApps.reusedApps, env.ports);
		if (candidates.names.length) await takeOver(candidates);
	}

	// ── Expose planning ──────────────────────────────────────────────────────
	if (args.exposeRequested) {
		await tunnels.planExpose({
			exposeValue: args.exposeValue,
			appsRequested: selectedAppNames !== undefined,
			selectedAppNames: new Set(Object.keys(appsForDev)),
			selectedServiceNames: new Set(plan.requiredServiceKeys),
			startAppNames: new Set(Object.keys(classifiedApps.startApps)),
			reusedAppNames: new Set(Object.keys(classifiedApps.reusedApps)),
		});
		if (args.oneShot) {
			await tunnels.openOwnedTunnels();
		}
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
		return exitWith(await runCliSeed(env, signal));
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

	// Decided before the summary and the banner, so both describe what this run
	// ends up doing rather than a reuse the takeover is about to undo.
	let nothingToSpawn = classifiedApps.startNames.length === 0;
	const takeover =
		!args.takeover &&
		nothingToSpawn &&
		!tunnels.hasPendingTargets() &&
		!connect?.active
			? takeoverCandidates(classifiedApps.reusedApps, env.ports)
			: undefined;

	if (takeover && takeover.names.length > 0) {
		const accepted = isInteractive() && (await promptTakeover(takeover.names));

		if (accepted) {
			await takeOver(takeover);
			nothingToSpawn = false;
		}
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
		{ signal, takeover: args.takeover },
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

	if (nothingToSpawn && !tunnels.hasPendingTargets() && !connect?.active) {
		if (overlapSeed)
			assertSeedSucceeded(
				await timer.measure("seed", () => env.runSeed({ signal })),
			);
		timer.report();
		log.success("Selected apps are already running. Nothing to start.");
		if (takeover && takeover.names.length > 0 && !isInteractive()) {
			log.hint("Pass --takeover to stop them and run here instead.");
		}
		await teardown(env, tunnels, connect);
		return undefined;
	}

	const appsStartedAt = performance.now();
	let firstSpawn = false;
	const view = openDevOutput(env, classifiedApps.startApps, { tui: args.tui });

	try {
		// After every prompt and the banner, which stay in the scrollback.
		view.start();
		// The TUI covers that scrollback: repeat why an app is missing in its
		// Overview (events are not printed again in stream mode).
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
				waitForHealth: (apps, healthSignal) =>
					env.waitForServers({
						onlyApps: Object.keys(apps) as Extract<keyof TApps, string>[],
						expandRequired: false,
						logReady: !overlapSeed,
						signal: healthSignal,
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
								env.runSeed({ signal: seedSignal, prefixOutput: true }),
							)
					: undefined,
				stayOpen: nothingToSpawn ? waitForShutdownSignal : undefined,
				projectName: env.projectName,
				runtime: hasServices ? containerRuntimeForEnv(env) : undefined,
				skipContainers: !hasServices,
				onPhase: timer.record,
				onReady: async () => {
					if (!nothingToSpawn)
						timer.record("app readiness", performance.now() - appsStartedAt);
					timer.report();
				},
				attach: args.attach,
				extraArgs: args.passthrough,
				output: view.output,
				waitForExit: true,
				onSignal: () => {
					void env.releaseRun();
				},
				waitForHealth: async (apps) => {
					await markApps(env, Object.keys(apps), "ready");
				},
				// A developer's other apps should not go down with one that
				// never came up; `ci` and library starts keep failing the run.
				keepOthersOnFailure: env.onAppFailure !== "stop-run",
				watch: args.watch,
				onAppFailed: (name) => {
					void markApps(env, [name], "failed");
				},
				// Deliberately not awaited: the registry is a status file, and
				// nothing about starting servers may wait on it.
				onAppSpawned: (name, pid, attached) => {
					if (!firstSpawn) {
						firstSpawn = true;
						timer.record("entry to first app spawn", timer.elapsedMs());
					}
					void recordAppSpawn(env, name, pid, attached);
				},
				// A signalled exit (`code === null`) is a deliberate stop — Ctrl-C,
				// or `buncargo stop <app>` — and reads as `stopped`. A non-zero code
				// is the app falling over, which the supervisor also turns into a
				// failed run.
				onAppExit: (name, code, signal) => {
					const app = appsForDev[name];
					void markApps(
						env,
						[name],
						isDeliberateExit(code, signal) &&
							!(code === 0 && app?.kind === "worker" && app.essential !== false)
							? "stopped"
							: "failed",
					);
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
		view.stop();
		await teardown(env, tunnels, connect);
	}
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
 * request ignores `seed.check`. Exits 1 on failure, like every other flow.
 */
async function runCliSeed<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	signal?: AbortSignal,
): Promise<number> {
	const outcome = await env.runSeed({ force: true, signal });

	if (outcome.status === "not-configured") {
		throw new CliError("No seed command is configured.", [
			"Add a seed block to your dev config:",
			"  seed: { command: 'bun run run:seeder' }",
		]);
	}

	if (outcome.status === "failed") {
		if (outcome.result.stdout) log.hint(outcome.result.stdout);
		return 1;
	}

	log.line();
	log.success("Seeding complete");
	return 0;
}
