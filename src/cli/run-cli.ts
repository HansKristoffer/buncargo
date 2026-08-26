import { execSync } from "node:child_process";
import { removeHostRoutes } from "../core/hosts";
import { isPortInUse, startDevServers } from "../core/process";
import { joinColoredNames } from "../core/style";
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
import { type DevCliArgs, parseDevArgs, printDevHelp } from "./dev-flags";
import { activateNamedHosts, releaseNamedHosts } from "./dev-hosts";
import {
	createTunnelCoordinator,
	type DevTunnelCoordinator,
	type TunnelApi,
} from "./dev-tunnels";
import { CliError, toCliError } from "./errors";
import * as log from "./log";
import { classifyCliApps, parseRequiredCommaSeparatedFlag } from "./port-reuse";

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

/**
 * Report an argv problem and exit. Nothing has been started yet, so this is
 * the one place that exits without tearing anything down.
 */
function exitWithArgError(
	messages: string[],
	options: { showHelp?: boolean } = {},
): never {
	for (const message of messages) {
		log.error(message);
	}
	if (options.showHelp) {
		log.line();
		printDevHelp();
	}
	process.exit(1);
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

	if (args.unknownFlags.length > 0) {
		exitWithArgError(
			[
				`Unknown flag${args.unknownFlags.length > 1 ? "s" : ""}: ${args.unknownFlags.join(", ")}`,
			],
			{ showHelp: true },
		);
	}

	if (args.errors.length > 0) {
		exitWithArgError(args.errors);
	}

	const tunnels = createTunnelCoordinator(
		env,
		cliTestTunnel ?? {
			resolveExposeTargets,
			startPublicTunnels,
			stopPublicTunnels,
		},
		{ exposeRequested: args.exposeRequested },
	);

	let exitCode: DevFlowExit;
	try {
		exitCode = await runDevFlow(env, args, tunnels, { watchdog });
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
	options: { watchdog: boolean },
): Promise<DevFlowExit> {
	async function exitWith(code: number): Promise<number> {
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
	await activateNamedHosts(env, { enabled: args.hosts });
	await env.start({
		startServers: false,
		wait: true,
		skipSeed: args.seed,
		skipEnvironmentLog: true,
		onlyApps: selectedAppNames,
		autoStartDocker: args.dockerAutostart ? undefined : false,
	});

	let classifiedApps = await classifyCliApps(appsForDev, env.ports, {
		isPortBusy: isPortInUse,
		waitForServer: env.waitForServer.bind(env),
		context: { root: env.root, projectName: env.projectName },
	});

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

	logSelectedAppsSummary(classifiedApps);

	if (!args.exposeRequested) {
		env.logInfo();
	}

	const nothingToSpawn = classifiedApps.startNames.length === 0;
	if (nothingToSpawn && !tunnels.hasPendingTargets()) {
		log.success("Selected apps are already running. Nothing to start.");
		await teardown(env, tunnels);
		return undefined;
	}

	const keepContainers = args.keepContainers || env.autoShutdown === false;
	if (options.watchdog && !keepContainers) {
		await spawnWatchdog(env.projectName, env.root, {
			timeoutMinutes: resolveWatchdogTimeoutMinutes(
				args.watchdogTimeoutMinutes,
				env.autoShutdown,
			),
			verbose: true,
			composeFile: env.composeFile,
		});
		startHeartbeat(env.projectName, undefined, env.root);
	}

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
