import { execSync } from "node:child_process";
import { containerRuntimeForEnv } from "../container-runtime";
import { removeHostRoutes } from "../core/hosts";
import { isDeliberateExit, startDevServers } from "../core/process";
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
import { spawnWatchdog, startHeartbeat, stopHeartbeat } from "../core/watchdog";
import { WATCHDOG_IDLE_TIMEOUT_MS } from "../core/watchdog-constants";
import { resolveSelectedApps } from "../planning";
import type {
	AppConfig,
	CliOptions,
	DevEnvironment,
	ServiceConfig,
} from "../types";
import { offerMenuBarApp } from "./bar-offer";
import {
	type DevCliArgs,
	exitOnDevArgErrors,
	parseDevArgs,
	printDevHelp,
} from "./dev-flags";
import { activateNamedHosts, releaseNamedHosts } from "./dev-hosts";
import {
	createTunnelCoordinator,
	type DevTunnelCoordinator,
	type TunnelApi,
} from "./dev-tunnels";
import { CliError, toCliError } from "./errors";
import * as log from "./log";
import { classifyCliApps, parseRequiredCommaSeparatedFlag } from "./port-reuse";
import {
	markApps,
	patchCurrentRun,
	publishCurrentRun,
	withdrawCurrentRun,
} from "./run-publish";
import {
	isInteractive,
	promptTakeover,
	stopRunningApps,
	takeoverCandidates,
} from "./takeover";

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
}): void {
	const { startNames, reusedNames, inferredReuseNames } = input;

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
}

function resolveWatchdogTimeoutMinutes(
	minutes: number | undefined,
	autoShutdown: number | boolean | undefined,
): number {
	if (minutes !== undefined) {
		return minutes;
	}
	const timeoutMs =
		typeof autoShutdown === "number" ? autoShutdown : WATCHDOG_IDLE_TIMEOUT_MS;
	return Number.isFinite(timeoutMs)
		? timeoutMs / 60_000
		: WATCHDOG_IDLE_TIMEOUT_MS / 60_000;
}

function waitForShutdownSignal(): Promise<void> {
	return new Promise<void>((resolve) => {
		const done = () => {
			process.off("SIGINT", done);
			process.off("SIGTERM", done);
			process.off("SIGHUP", done);
			resolve();
		};
		process.on("SIGINT", done);
		process.on("SIGTERM", done);
		process.on("SIGHUP", done);
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

	const tunnels = createTunnelCoordinator(
		env,
		cliTestTunnel ?? {
			resolveExposeTargets,
			startPublicTunnels,
			stopPublicTunnels,
		},
		{ exposeRequested: args.exposeRequested },
	);

	const timer = args.timing ? createPhaseTimer() : createNoopPhaseTimer();

	let exitCode: DevFlowExit;
	try {
		exitCode = await runDevFlow(env, args, tunnels, { watchdog, timer });
	} catch (error) {
		reportCliError(toCliError(error));
		await teardown(env, tunnels);
		process.exit(1);
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
): Promise<void> {
	await tunnels.stop();
	await releaseNamedHosts(env);
	// Withdrawn beside the host routes, and for the same reason: both advertise
	// something this process is about to stop answering for.
	await withdrawCurrentRun(env.root);
	restoreTerminal();
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
	options: { watchdog: boolean; timer: PhaseTimer },
): Promise<DevFlowExit> {
	const { timer } = options;
	async function exitWith(code: number): Promise<number> {
		// The one-shot modes end here, and `--up-only` is exactly the kind of
		// run someone times.
		timer.report();
		await teardown(env, tunnels);
		return code;
	}

	if (args.down && args.all) {
		const { stopAllBuncargoEnvironments } = await import("./commands/inspect");
		await stopAllBuncargoEnvironments();
		return 0;
	}

	if (args.down || args.reset) {
		env.logInfo();
		await tunnels.stop();
		await removeHostRoutes((route) => route.root === env.root);
		await env.stop({ removeVolumes: args.reset });
		restoreTerminal();
		return 0;
	}

	// ── App selection ────────────────────────────────────────────────────────
	// argv only ever yields plain strings. `resolveSelectedApps` drops names that
	// are not configured apps and the check below fails when nothing is left, so
	// this is the single place the CLI crosses into the config's app keys.
	let selectedAppNames: Extract<keyof TApps, string>[] | undefined;
	let appsForDev: Record<string, AppConfig> = resolveSelectedApps(
		env.apps,
		undefined,
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

	// ── Containers ───────────────────────────────────────────────────────────
	// Held rather than printed: a run that takes over another one activates a
	// second time, and the failure this first attempt reports - the other run
	// still owning the hostnames - is exactly what the takeover undoes.
	let hostsWarnings = await timer.measure("hosts", () =>
		activateNamedHosts(env, { enabled: args.hosts }),
	);
	// After named hosts, which owns the first-run prompt slot on a fresh
	// machine, and before the containers, so a question cannot land in the
	// middle of startup output.
	await offerMenuBarApp();
	const flushHostsWarnings = (): void => {
		for (const warning of hostsWarnings) log.warn(warning);
		hostsWarnings = [];
	};
	await timer.measure("containers", () =>
		env.start({
			startServers: false,
			wait: true,
			skipSeed: args.seed,
			skipEnvironmentLog: true,
			onlyApps: selectedAppNames,
			autoStartDocker: args.dockerAutostart ? undefined : false,
		}),
	);

	let classifiedApps = await timer.measure("app ports", () =>
		classifyCliApps(appsForDev, env.ports, {
			// No `isPortBusy` override: the default reads every app port from
			// one snapshot rather than probing each of them separately.
			waitForServer: env.waitForServer.bind(env),
			context: { root: env.root, projectName: env.projectName },
		}),
	);

	// ── Expose planning ──────────────────────────────────────────────────────
	if (args.exposeRequested) {
		await tunnels.planExpose({
			exposeValue: args.exposeValue,
			appsRequested: args.appsRequested,
			selectedAppNames: new Set(Object.keys(appsForDev)),
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
		env.logInfo();
		log.line();
		log.success("Migrations applied successfully");
		return exitWith(0);
	}

	if (args.seed) {
		return exitWith(await runCliSeed(env));
	}

	if (args.upOnly) {
		env.logInfo();
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
		nothingToSpawn && !tunnels.hasPendingTargets()
			? takeoverCandidates(classifiedApps.reusedApps, env.ports)
			: undefined;

	if (takeover && takeover.names.length > 0) {
		const accepted =
			args.takeover ||
			(isInteractive() && (await promptTakeover(takeover.names)));
		if (accepted) {
			log.line();
			await stopRunningApps(takeover.names, env.ports, {
				runtime: containerRuntimeForEnv(env),
			});
			// The other run held this project's hostnames, so the activation
			// before the containers started was refused and `env.urls` fell back
			// to localhost. Its routes are claimable now that its pid is gone.
			hostsWarnings = await activateNamedHosts(env, { enabled: args.hosts });
			classifiedApps = {
				startApps: takeover.apps,
				startNames: takeover.names,
				reusedApps: {},
				reusedNames: [],
				inferredReuseNames: [],
			};
			nothingToSpawn = false;
		}
	}

	flushHostsWarnings();

	// Published here, after the takeover has been decided: before it, the app
	// classification still describes a reuse the takeover is about to undo, and
	// `env.urls` may still hold the localhost fallback from the refused first
	// activation.
	await publishCurrentRun(env, {
		apps: { ...classifiedApps.startApps, ...classifiedApps.reusedApps },
		reusedNames: classifiedApps.reusedNames,
		attached: args.attach,
	});

	logSelectedAppsSummary(classifiedApps);

	if (!args.exposeRequested) {
		env.logInfo();
	}

	if (nothingToSpawn && !tunnels.hasPendingTargets()) {
		timer.report();
		log.success("Selected apps are already running. Nothing to start.");
		if (takeover && takeover.names.length > 0 && !isInteractive()) {
			log.hint("Pass --takeover to stop them and run here instead.");
		}
		await teardown(env, tunnels);
		return undefined;
	}

	const keepContainers = args.keepContainers || env.autoShutdown === false;
	if (options.watchdog && !keepContainers) {
		// Heartbeat first, then the watchdog: the runner's first poll reads this
		// file, and a missing one is owner-death to it. Writing it up front means
		// the ordering cannot matter however slowly the runner starts.
		startHeartbeat(env.projectName, undefined, env.root);
		// Deliberately not awaited. Confirming the runner came up costs up to two
		// seconds of polling a pid file, and nothing about starting dev servers
		// depends on the answer — the watchdog only matters once this run is
		// gone. It still reports a failure to start, just not before the servers.
		void spawnWatchdog(env.projectName, env.root, {
			timeoutMinutes: resolveWatchdogTimeoutMinutes(
				args.watchdogTimeoutMinutes,
				env.autoShutdown,
			),
			verbose: true,
			composeFile: env.composeFile,
			containerRuntime: env.containerRuntime,
		}).catch(() => {
			// spawnWatchdog reports its own failures; an idle backstop that did
			// not start must never take the dev run down with it.
		});
	}

	// Printed before the servers take over the terminal: after that the output
	// is theirs, and a summary landing in the middle of it is noise.
	timer.report();

	try {
		if (nothingToSpawn) {
			await tunnels.openOwnedTunnels();
			await waitForShutdownSignal();
			return undefined;
		}

		await startDevServers(
			classifiedApps.startApps,
			env.root,
			(name) => env.buildAppEnvVars(name as Extract<keyof TApps, string>),
			env.ports,
			{
				projectName: env.projectName,
				attach: args.attach,
				extraArgs: args.passthrough,
				waitForExit: true,
				onSignal: () => {
					stopHeartbeat();
				},
				waitForHealth: async (apps) => {
					await env.waitForServers({
						// These came out of `env.apps`, so they are app keys already.
						onlyApps: Object.keys(apps) as Extract<keyof TApps, string>[],
						expandRequired: false,
					});
					await markApps(env.root, Object.keys(apps), "ready");
				},
				// Deliberately not awaited: the registry is a status file, and
				// nothing about starting servers may wait on it.
				onAppSpawned: (name, pid, attached) => {
					void patchCurrentRun(env.root, {
						apps: [{ name, pid, attached: attached || undefined }],
					});
				},
				// A signalled exit (`code === null`) is a deliberate stop — Ctrl-C,
				// or `buncargo stop <app>` — and reads as `stopped`. A non-zero code
				// is the app falling over, which the supervisor also turns into a
				// failed run.
				onAppExit: (name, code) => {
					void markApps(
						env.root,
						[name],
						isDeliberateExit(code) ? "stopped" : "failed",
					);
				},
				onAfterWave1: tunnels.openOwnedTunnels,
				// Nothing to wait for without --expose, so needsPublicUrls apps
				// join wave 1 and get health-checked like everything else.
				deferPublicUrlApps: args.exposeRequested,
			},
		);
		return undefined;
	} finally {
		stopHeartbeat();
		await teardown(env, tunnels);
	}
}

/**
 * `--seed` runs the environment's seed path with `force`, so an explicit seed
 * request ignores `seed.check`. Exits 1 on failure, like every other flow.
 */
async function runCliSeed<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(env: DevEnvironment<TServices, TApps>): Promise<number> {
	const outcome = await env.runSeed({ force: true });

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
