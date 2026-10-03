import type { ChildProcess, SpawnOptions } from "node:child_process";
import { resolve } from "node:path";
import type { ContainerRuntimeAdapter } from "../../container-runtime/types";
import type { AppConfig, DevServerPids } from "../../types";
import { waitForDevServers } from "../network";
import { connectProcessEnv } from "../runtime-flags";
import { loadAppSecrets, missingRequiredSecrets } from "../secrets/infisical";
import { formatStep, formatWarn, prefixWidth } from "../style";
import {
	ptyTeeArgv,
	resolveStartCommand,
	runPrebuild,
	spawnAppCommand,
	spawnManagedApp,
} from "./app-process";
import { AppSupervision } from "./app-supervision";
import { createCaptureRestarts } from "./capture-restarts";
import type { CapturedValue } from "./output-capture";
import {
	classifyPortOccupant,
	createPortOwnerSnapshotAsync,
	formatPortOwner,
	getPortOwner,
	killPortOwner,
	type PortOwnerSnapshot,
} from "./port-owner";
import { RunInterrupted } from "./process-owner";
import { printStream, RunOutput } from "./run-output";

export { stopDevServers } from "./app-supervision";

import { planSpawnOrder } from "./start-order";
import { spawnOwnedWorker } from "./worker-ownership";

/**
 * Did this app stop because something asked it to?
 *
 * `null` is a process killed by a signal outright. The two codes are
 * `128 + SIGINT` and `128 + SIGTERM`, which is what a shell wrapper reports
 * when the signal reached it rather than the server it spawned — `bun run dev`
 * does exactly that. Without them a Ctrl-C, or a `buncargo stop`, ends a clean
 * shutdown with "App exited with code 143" and a failed run.
 */
export function isDeliberateExit(
	code: number | null,
	signal?: NodeJS.Signals | null,
): boolean {
	return (
		(code === null &&
			(signal === undefined || signal === "SIGINT" || signal === "SIGTERM")) ||
		code === 0 ||
		code === 130 ||
		code === 143
	);
}

export interface SpawnDevServerOptions {
	verbose?: boolean;
	detached?: boolean;
	isCI?: boolean;
	/** Kill any existing process using the port before starting. Default: true */
	killExisting?: boolean;
	/** The port this server will use (required if killExisting is true) */
	port?: number;
}

/**
 * @deprecated Prefer startDevServers for ownership, readiness and supervision.
 * Spawn a dev server as a detached process.
 * If killExisting is true and port is provided, kills any existing process on that port first.
 */
export async function spawnDevServer(
	command: string,
	root: string,
	appCwd: string | undefined,
	envVars: Record<string, string>,
	options: SpawnDevServerOptions = {},
): Promise<ChildProcess> {
	const {
		verbose = false,
		detached = true,
		isCI = false,
		killExisting = true,
		port,
	} = options;

	if (killExisting && port !== undefined) {
		const owner = getPortOwner(port);
		if (owner) {
			if (verbose) {
				console.log(formatWarn(`Port ${port} is in use`));
			}

			await killPortOwner(port, { verbose });
		}
	}

	const spawnOptions: SpawnOptions = {
		cwd: appCwd ? resolve(root, appCwd) : root,
		env: connectProcessEnv({ ...process.env, ...envVars }),
		detached,
		stdio: isCI || verbose ? "inherit" : "ignore",
	};

	const proc = spawnAppCommand(command, spawnOptions);

	if (detached && proc.unref) {
		proc.unref();
	}

	await new Promise<void>((resolvePromise, rejectPromise) => {
		proc.once("error", rejectPromise);
		proc.once("spawn", resolvePromise);
	});
	return proc;
}

export interface StartDevServersOptions {
	onPhase?: (name: string, ms: number) => void;
	/** Reports a supervised failure after a library start returned its pids. */
	onFailure?: (error: unknown) => void;
	skipContainers?: boolean;
	signal?: AbortSignal;
	shutdownGraceMs?: number;
	runtime?: ContainerRuntimeAdapter;
	/** All selected app waves have completed readiness. */
	onReady?: (signal?: AbortSignal) => void | Promise<void>;
	onAppReady?: (name: string) => void;
	verbose?: boolean;
	productionBuild?: boolean;
	isCI?: boolean;
	/** Compose/project name used to classify port occupants. */
	projectName?: string;
	/** App that owns the TTY. Others get prefixed pipes. Ignored by the TUI. */
	attach?: string;
	/**
	 * Where app output goes. Default: prefixed lines on stdout. The TUI passes
	 * one with `terminalSize` set, which gives every app its own terminal.
	 */
	output?: RunOutput;
	/** Extra args appended to the attached app command. */
	extraArgs?: string[];
	/** Called after wave-1 apps are healthy (CLI opens tunnels here). */
	onAfterWave1?: (signal?: AbortSignal) => Promise<void>;
	/**
	 * Hold `needsPublicUrls` apps back for wave 2. Default: true.
	 *
	 * The whole point of wave 2 is to spawn after `onAfterWave1` has published
	 * tunnel URLs, so when no tunnel is opening there is nothing to wait for and
	 * deferring only costs those apps their health check. Pass the expose flag
	 * here and a single static config behaves correctly with and without it.
	 */
	deferPublicUrlApps?: boolean;
	/** Supervise children until they exit. Default: false */
	waitForExit?: boolean;
	/** Called once when SIGINT/SIGTERM/SIGHUP arrives (waitForExit only). */
	onSignal?: () => void | Promise<void>;
	/** Override wave-1 health wait. */
	waitForHealth?: (
		apps: Record<string, AppConfig>,
		signal?: AbortSignal,
	) => Promise<void>;
	/**
	 * A dev server was spawned, with the pid of the process group leader.
	 *
	 * The return value is awaited nowhere: this reports state to the run
	 * registry, and nothing about starting servers may wait on that.
	 */
	onAppSpawned?: (name: string, pid: number, attached: boolean) => void;
	/**
	 * An app printed a value one of its `captures` matched. Returns the keys
	 * that changed (`captured.<name>`, `publicUrls.<app>`); apps whose
	 * `restartOn` names one are restarted with fresh env.
	 */
	onCapture?: (
		app: string,
		captured: CapturedValue,
	) => readonly string[] | Promise<readonly string[]>;
	/**
	 * A dev server exited. `code` is `null` when it was signalled, which is what
	 * a `buncargo stop <app>` or a Ctrl-C looks like from here.
	 */
	onAppExit?: (
		name: string,
		code: number | null,
		signal?: NodeJS.Signals | null,
	) => void;
}

function resolveAppEnv(
	envVarsByApp:
		| Record<string, Record<string, string>>
		| ((name: string) => Record<string, string>),
	name: string,
): Record<string, string> {
	return typeof envVarsByApp === "function"
		? envVarsByApp(name)
		: (envVarsByApp[name] ?? {});
}

async function prepareAppPort(
	name: string,
	port: number | undefined,
	root: string,
	projectName: string,
	verbose: boolean,
	ports: PortOwnerSnapshot,
	runtime?: ContainerRuntimeAdapter,
	skipContainers?: boolean,
): Promise<"reuse" | "start"> {
	if (port === undefined) {
		return "start";
	}

	const owner = ports.owner(port);
	const action = classifyPortOccupant(owner, {
		root,
		projectName,
		runtime: runtime?.name,
	});
	if (action === "reuse") {
		if (verbose) {
			console.log(
				formatStep(`♻️  Reusing existing process on port ${port} (${name})`),
			);
		}

		return "reuse";
	}

	if (action === "fail" && owner) {
		throw new Error(formatPortOwner(port, owner, { runtime: runtime?.name }));
	}

	if (action === "kill") {
		await killPortOwner(port, { verbose, runtime, skipContainers });
	}

	return "start";
}

/**
 * Start configured dev servers, holding `needsPublicUrls` apps for a second
 * wave when tunnels are opening (see `deferPublicUrlApps`).
 */
export async function startDevServers(
	apps: Record<string, AppConfig>,
	root: string,
	envVarsByApp:
		| Record<string, Record<string, string>>
		| ((name: string) => Record<string, string>),
	ports: Record<string, number>,
	options: StartDevServersOptions = {},
): Promise<DevServerPids> {
	const {
		verbose = true,
		productionBuild = false,
		projectName = "",
		attach: attachOverride,
		extraArgs = [],
		onAfterWave1,
		waitForExit = false,
		onSignal,
		waitForHealth,
		deferPublicUrlApps = true,
		onAppSpawned,
		onAppExit,
		onCapture,
	} = options;

	const startable = Object.fromEntries(
		Object.entries(apps).filter(
			([, app]) => resolveStartCommand(app, productionBuild) !== undefined,
		),
	);
	// Here rather than in the environment layer because this is the one function
	// every spawner goes through: `startAppServers` and the CLI's own dev flow
	// both land here, and a third caller cannot miss it. Lowest precedence — the
	// app's computed env is layered on top, and `spawnManagedApp` puts the
	// developer's own `process.env` in between. `loadAppSecrets` returns an empty
	// map without spawning anything when no app declared a scope.
	const secrets = await loadAppSecrets(startable, undefined, {
		signal: options.signal,
		onWait: (ms) => options.onPhase?.("secrets", ms),
	});
	const appEnv = (name: string) => ({
		...secrets[name],
		...resolveAppEnv(envVarsByApp, name),
	});

	// Before anything spawns: one error naming every missing key per app,
	// rather than each app crashing on its own first read of one.
	const missing = missingRequiredSecrets(startable, (name) => ({
		...process.env,
		...appEnv(name),
	}));
	if (Object.keys(missing).length > 0) {
		throw new Error(
			`Required secrets are missing:\n${Object.entries(missing)
				.map(([name, keys]) => `  ${name}: ${keys.join(", ")}`)
				.join(
					"\n",
				)}\nAdd them to the app's Infisical scope, or export them. \`buncargo secrets ls\` shows what each app gets.`,
		);
	}

	const order = planSpawnOrder(startable, deferPublicUrlApps);
	const nameWidth = prefixWidth(Object.keys(startable));
	const output = options.output ?? new RunOutput();
	const stopPrinting = options.output
		? undefined
		: printStream(output, { width: nameWidth });
	// In the TUI every app has a terminal of its own: none needs the real one.
	const configuredInteractive = output.terminalSize
		? undefined
		: Object.entries(startable).find(([, app]) => app.interactive)?.[0];
	const attachedName = attachOverride ?? configuredInteractive;
	if (attachOverride && !startable[attachOverride]) {
		throw new Error(`--attach=${attachOverride} is not in the start set`);
	}
	const optional = new Set(
		Object.entries(startable)
			.filter(([, app]) => app.essential === false)
			.map(([name]) => name),
	);

	const session = new AppSupervision({
		signal: options.signal,
		shutdownGraceMs: options.shutdownGraceMs,
		attachedName,
		optional,
		onAppExit: (name, code, signal) => {
			if (!owner.controller.signal.aborted) {
				// After the app's last screen, so its final words precede the verdict.
				const report = () =>
					output.state(name, {
						state:
							isDeliberateExit(code, signal) &&
							!(
								code === 0 &&
								startable[name]?.kind === "worker" &&
								!optional.has(name)
							)
								? "stopped"
								: "failed",
						detail: signal ? `signal ${signal}` : `exit ${code}`,
						restartable: optional.has(name),
					});
				const screen = output.screens.get(name);
				if (screen) void screen.flush().then(report);
				else report();
			}
			onAppExit?.(name, code, signal);
		},
		onAppSpawned: (name, pid, attached) => {
			output.state(name, { state: "starting" });
			onAppSpawned?.(name, pid, attached);
		},
		onRestart: (name, reason) => {
			output.event(name, `restarting: ${reason}`);
			if (!output.terminalSize)
				console.log(formatStep(`🔁 Restarting ${name}: ${reason}`));
		},
		verbose: verbose && !output.terminalSize,
		width: nameWidth,
	});
	const owner = session.owner;
	const pids = session.pids;
	let handedOff = false;
	// A replaced app is ready again the way it was the first time: health-
	// checked on the side, so a failing restart never stalls the others.
	const restartApp = async (name: string, reason?: string) => {
		await session.restart(name, reason);
		const config = startable[name];
		if (config && !owner.controller.signal.aborted)
			void waitForWave({ [name]: config }).catch(() => {});
	};
	output.controls = { restart: (name) => restartApp(name, "requested") };
	const markReady = (name: string) => {
		owner.ready(name);
		if (output.states.get(name)?.state === "ready") return;
		output.state(name, { state: "ready" });
		options.onAppReady?.(name);
	};

	const scannerFor = createCaptureRestarts(startable, {
		signal: owner.controller.signal,
		onCapture: (app, captured) => {
			output.capture(app, captured);
			return onCapture?.(app, captured) ?? [];
		},
		restart: (name) => restartApp(name),
	});

	async function spawnWave(wave: Record<string, AppConfig>): Promise<void> {
		// Per wave, not per run: a later wave spawns after tunnels have opened
		// and earlier servers have bound their ports, so a snapshot taken before
		// the first wave would be describing a machine that has since changed.
		owner.controller.signal.throwIfAborted();
		const portOwners = await createPortOwnerSnapshotAsync({
			signal: owner.controller.signal,
			runtime: options.runtime,
			skipContainers: options.skipContainers,
			ports: Object.keys(wave).flatMap((name) => {
				const port = ports[name];
				return port === undefined ? [] : [port];
			}),
		});
		const toStart: [string, AppConfig][] = [];
		for (const [name, config] of Object.entries(wave)) {
			const prepared = await prepareAppPort(
				name,
				ports[name],
				root,
				projectName,
				verbose,
				portOwners,
				options.runtime,
				options.skipContainers,
			);
			owner.controller.signal.throwIfAborted();
			if (prepared !== "reuse") toStart.push([name, config]);
		}

		// A wave's prebuilds run side by side, and all finish before any of its
		// apps spawns: a watcher's first rebuild must not race its own build.
		await owner.race(
			Promise.all(
				toStart.map(([name, config]) =>
					runPrebuild(name, config, root, appEnv(name), {
						signal: owner.controller.signal,
						output,
					}),
				),
			),
		);

		for (const [name, config] of toStart) {
			const attached = name === attachedName;
			const onText = scannerFor(name, config);
			if (
				attached &&
				onText &&
				!output.terminalSize &&
				process.stdin.isTTY &&
				!ptyTeeArgv("")
			) {
				console.warn(
					formatWarn(
						`${name}'s captures are not read: no \`script\` command to run it under a terminal.`,
					),
				);
			}
			const spawnOnce = () =>
				spawnManagedApp(name, config, root, appEnv(name), {
					attached,
					extraArgs: attached ? extraArgs : [],
					productionBuild,
					waitForExit,
					output,
					onText,
				});
			const spawnApp = () =>
				config.kind === "worker"
					? spawnOwnedWorker(root, name, spawnOnce, owner.controller.signal)
					: Promise.resolve(spawnOnce());
			session.setSpawner(
				name,
				spawnApp,
				config.kind === "worker",
				attached,
				config.kind === "worker" ? undefined : ports[name],
			);
			const child = await spawnApp();
			await session.register(
				name,
				child,
				config.kind === "worker",
				attached,
				config.kind !== "worker" && config.healthEndpoint !== false,
				config.kind === "worker" ? undefined : ports[name],
			);
		}
	}

	function waitForWave(wave: Record<string, AppConfig>): Promise<void> {
		if (waitForHealth)
			return waitForHealth(wave, owner.controller.signal).then(() => {
				for (const name of Object.keys(wave)) markReady(name);
			});
		// Workers and `healthEndpoint: false` apps are ready once the wave is.
		return waitForDevServers(wave, ports, {
			verbose: verbose && !output.terminalSize,
			productionBuild,
			signal: owner.controller.signal,
			onAppReady: markReady,
		}).then(() => {
			for (const name of Object.keys(wave)) markReady(name);
		});
	}

	async function startWave(wave: Record<string, AppConfig>): Promise<void> {
		if (Object.keys(wave).length === 0) {
			return;
		}

		await spawnWave(wave);
		// A non-essential app never holds the run up: it is health-checked on
		// the side, and its failing to come up is its own problem.
		for (const name of Object.keys(wave).filter((name) => optional.has(name)))
			void waitForWave({ [name]: wave[name] as AppConfig }).catch(() => {});
		await owner.race(
			waitForWave(
				Object.fromEntries(
					Object.entries(wave).filter(([name]) => !optional.has(name)),
				),
			),
		);
	}
	try {
		// Each layer is healthy before the next spawns: that is `startAfter`.
		for (const layer of order.beforeTunnels) await startWave(layer);
		if (onAfterWave1) {
			await owner.race(onAfterWave1(owner.controller.signal));
		}

		for (const layer of order.afterTunnels) await startWave(layer);
		owner.controller.signal.throwIfAborted();
		if (options.onReady) {
			await owner.race(
				Promise.resolve().then(() =>
					options.onReady?.(owner.controller.signal),
				),
			);
		}

		if (waitForExit) {
			await owner.wait();
			await session.stop();
		} else {
			handedOff = true;
			void (async () => {
				try {
					await owner.wait();
				} catch (error) {
					if (!(error instanceof RunInterrupted) && !options.signal?.aborted) {
						if (options.onFailure) {
							options.onFailure(error);
						} else {
							console.error(error);
						}
					}
				} finally {
					try {
						await session.stop();
					} finally {
						session.dispose();
						output.close();
						stopPrinting?.();
					}
				}
			})().catch((error) => console.error(error));
		}

		return pids;
	} catch (error) {
		try {
			await session.stop();
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"App startup or shutdown failed",
			);
		}

		if (error instanceof RunInterrupted) {
			await onSignal?.();
			return pids;
		}
		throw error;
	} finally {
		if (!handedOff) {
			session.dispose();
			output.close();
			stopPrinting?.();
		}
	}
}
