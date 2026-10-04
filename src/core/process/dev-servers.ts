import { resolve } from "node:path";
import type { ContainerRuntimeAdapter } from "../../container-runtime/types";
import type { AppConfig, DevServerPids } from "../../types";
import { abortableSleep } from "../deadline";
import { waitForDevServers } from "../network";
import { loadAppSecrets, missingRequiredSecrets } from "../secrets/infisical";
import { formatStep, formatWarn, prefixWidth } from "../style";
import {
	ptyTeeArgv,
	resolveStartCommand,
	runPrebuild,
	spawnManagedApp,
} from "./app-process";
import { AppSupervision } from "./app-supervision";
import { createCaptureRestarts } from "./capture-restarts";
import {
	type CapturedValue,
	createOutputCaptureScanner,
} from "./output-capture";
import {
	classifyPortOccupant,
	createPortOwnerSnapshotAsync,
	formatPortOwner,
	killPortOwner,
	type PortOwnerSnapshot,
} from "./port-owner";
import { RunInterrupted } from "./process-owner";
import { printStream, RunOutput } from "./run-output";

export { stopDevServers } from "./app-supervision";

import { watchApp } from "./app-watch";
import {
	type DriftProbe,
	systemDriftProbe,
	watchPortDrift,
} from "./port-drift";
import { planSpawnOrder } from "./start-order";
import { spawnOwnedWorker } from "./worker-ownership";

function toError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(String(reason));
}

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
	/**
	 * An app that does not become ready is stopped and the others keep
	 * running, unless a later app `startAfter`s it. Default: false, the run
	 * ends - what `ci` and a library `start()` want. `buncargo dev` turns it on.
	 */
	keepOthersOnFailure?: boolean;
	/** Start the apps' `watch` watchers. Default: true; `dev --no-watch` passes false. */
	watch?: boolean;
	/** An app was stopped because it did not become ready (see above). */
	onAppFailed?: (name: string, error: Error) => void;
	/**
	 * How to notice an app listening on another port than its own while it
	 * starts (see `port-drift.ts`). `false` turns it off. Default: the system.
	 */
	portDrift?: DriftProbe | false;
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
	// Apps whose current process has exited. Recorded the moment the exit is
	// seen, not when it is shown (that waits for the app's last screen), so
	// no readiness check can report a dead process ready in between.
	const exited = new Set<string>();
	// Apps stopped because they never became ready, and why.
	const readinessFailures = new Map<string, string>();

	const session = new AppSupervision({
		signal: options.signal,
		shutdownGraceMs: options.shutdownGraceMs,
		attachedName,
		optional,
		onAppExit: (name, code, signal) => {
			exited.add(name);
			sideChecks.get(name)?.abort();
			if (!owner.controller.signal.aborted) {
				// After the app's last screen, so its final words precede the verdict.
				const failure = readinessFailures.get(name);
				const report = () =>
					output.state(name, {
						state: failure
							? "failed"
							: isDeliberateExit(code, signal) &&
									!(
										code === 0 &&
										startable[name]?.kind === "worker" &&
										!optional.has(name)
									)
								? "stopped"
								: "failed",
						detail: failure ?? (signal ? `signal ${signal}` : `exit ${code}`),
						restartable: optional.has(name),
					});
				const screen = output.screens.get(name);
				if (screen) void screen.flush().then(report);
				else report();
			}
			onAppExit?.(name, code, signal);
		},
		onAppSpawned: (name, pid, attached) => {
			exited.delete(name);
			// A ready app reporting a new pid adopted its detached server;
			// a restart says "starting" itself.
			if (output.states.get(name)?.state !== "ready")
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
		readinessFailures.delete(name);
		sideChecks.get(name)?.abort();
		output.state(name, { state: "starting" });
		await session.restart(name, reason);
		checkOnTheSide(name);
	};
	output.controls = { restart: (name) => restartApp(name, "requested") };
	const markReady = (name: string) => {
		if (exited.has(name)) return;
		owner.ready(name);
		// Only a starting app becomes ready; an exited one stays as it ended.
		if (output.states.get(name)?.state !== "starting") return;
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
					onText: watchForReady(name, config, onText),
				});
			const spawnApp = () =>
				config.kind === "worker"
					? spawnOwnedWorker(root, name, spawnOnce, owner.controller.signal, {
							allowEarlyExit: optional.has(name),
						})
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

	function waitForWave(
		wave: Record<string, AppConfig>,
		signal: AbortSignal = owner.controller.signal,
	): Promise<void> {
		const ready = (name: string) => {
			if (!signal.aborted) markReady(name);
		};
		// Printed lines first: the health wait skips `readyWhen` apps, and its
		// callers mark the whole wave ready when it returns.
		const health = waitForPrinted(wave, signal).then(() =>
			waitForHealth
				? waitForHealth(wave, signal)
				: // Workers and `healthEndpoint: false` apps are ready once the wave is.
					waitForDevServers(wave, ports, {
						verbose: verbose && !output.terminalSize,
						productionBuild,
						signal,
						onAppReady: ready,
					}),
		);
		return raceDrift(wave, health, signal).then(() => {
			for (const name of Object.keys(wave)) ready(name);
		});
	}

	// An app that drifted to another port fails now rather than when its
	// health check times out.
	const driftProbe =
		options.portDrift === false
			? undefined
			: (options.portDrift ?? systemDriftProbe({ root, projectName }));
	async function raceDrift(
		wave: Record<string, AppConfig>,
		health: Promise<void>,
		signal: AbortSignal,
	): Promise<void> {
		if (!driftProbe) return health;
		const targets = () =>
			Object.entries(wave).flatMap(([name, config]) => {
				const pid = pids[name];
				const port = ports[name];
				return config.kind === "worker" ||
					config.healthEndpoint === false ||
					pid === undefined ||
					port === undefined ||
					exited.has(name)
					? []
					: [{ name, pid, port }];
			});
		const done = new AbortController();
		const drift = watchPortDrift(
			targets,
			driftProbe,
			AbortSignal.any([signal, done.signal]),
		);
		try {
			await Promise.race([health, drift.then(() => health)]);
		} finally {
			done.abort();
		}
	}

	// `readyWhen`: one promise per process, resolved when its output matches.
	// A fresh scanner per spawn, so a restart waits for the line again; the
	// app's own captures keep theirs, which report a value only when it changes.
	const printedReady = new Map<
		string,
		{ promise: Promise<void>; resolve: () => void }
	>();
	function watchForReady(
		name: string,
		config: AppConfig,
		onText: ((text: string) => void) | undefined,
	): ((text: string) => void) | undefined {
		if (!config.readyWhen) return onText;
		const { promise, resolve } = Promise.withResolvers<void>();
		printedReady.set(name, { promise, resolve });
		const scanner = createOutputCaptureScanner({
			ready: { pattern: config.readyWhen, as: "event" },
		});
		let seen = false;
		return (text) => {
			onText?.(text);
			if (!seen && scanner.push(text).length > 0) {
				seen = true;
				resolve();
			}
		};
	}
	/** Resolves once every `readyWhen` app of the wave has printed its line. */
	async function waitForPrinted(
		wave: Record<string, AppConfig>,
		signal: AbortSignal,
	): Promise<void> {
		await Promise.all(
			Object.entries(wave).map(async ([name, config]) => {
				const ready = printedReady.get(name);
				// Reused from another run: nothing of ours to read.
				if (!config.readyWhen || !ready) return;
				const timeoutMs = config.healthTimeout ?? 60_000;
				const done = new AbortController();
				try {
					await Promise.race([
						ready.promise,
						abortableSleep(
							timeoutMs,
							AbortSignal.any([signal, done.signal]),
						).then(() => {
							throw new Error(
								`${name} did not print ${config.readyWhen} within ${Math.round(timeoutMs / 1000)}s`,
							);
						}),
					]);
				} finally {
					done.abort();
				}
			}),
		);
	}

	// A non-essential app's readiness is checked on the side, one check per
	// process: its exit or replacement cancels it, so a check that outlives
	// the process cannot report the next one (or a dead one) as ready.
	const sideChecks = new Map<string, AbortController>();
	function checkOnTheSide(name: string): void {
		const config = startable[name];
		if (!config || owner.controller.signal.aborted || exited.has(name)) return;
		sideChecks.get(name)?.abort();
		const controller = new AbortController();
		sideChecks.set(name, controller);
		void waitForWave(
			{ [name]: config },
			AbortSignal.any([owner.controller.signal, controller.signal]),
		).catch(() => {});
	}

	async function startWave(wave: Record<string, AppConfig>): Promise<void> {
		if (Object.keys(wave).length === 0) {
			return;
		}

		await spawnWave(wave);
		// A non-essential app never holds the run up: it is health-checked on
		// the side, and its failing to come up is its own problem.
		for (const name of Object.keys(wave).filter((name) => optional.has(name)))
			checkOnTheSide(name);
		let essential = Object.fromEntries(
			Object.entries(wave).filter(([name]) => !optional.has(name)),
		);
		if (options.keepOthersOnFailure)
			essential = await spareHealthyApps(essential);
		await owner.race(waitForWave(essential));
	}

	/**
	 * Wait for each app on its own, so one that never comes up is named,
	 * stopped and parked while the rest of the wave carries on. Returns the
	 * apps that came up, for the wave's usual readiness wait.
	 */
	async function spareHealthyApps(
		wave: Record<string, AppConfig>,
	): Promise<Record<string, AppConfig>> {
		const signal = owner.controller.signal;
		const results = await owner.race(
			Promise.allSettled(
				Object.entries(wave).map(([name, config]) =>
					raceDrift(
						{ [name]: config },
						waitForPrinted({ [name]: config }, signal).then(() =>
							waitForDevServers({ [name]: config }, ports, {
								verbose: false,
								logReady: false,
								productionBuild,
								signal,
							}),
						),
						signal,
					),
				),
			),
		);
		signal.throwIfAborted();

		const healthy: Record<string, AppConfig> = {};
		const failed: [string, Error][] = [];
		for (const [index, [name, config]] of Object.entries(wave).entries()) {
			const result = results[index];
			if (result?.status === "fulfilled") healthy[name] = config;
			else failed.push([name, toError(result?.reason)]);
		}
		if (failed.length === 0) return healthy;

		// Decided before anything is parked, so a run that is about to fail
		// never reports that "the rest keeps going".
		for (const [name, error] of failed) {
			// Something waiting for it to be healthy cannot start without it.
			const dependents = Object.entries(startable)
				.filter(([, app]) => app.startAfter?.includes(name))
				.map(([dependent]) => dependent);
			if (dependents.length > 0)
				throw new Error(
					`${error.message} (${dependents.join(", ")} start${dependents.length === 1 ? "s" : ""} after ${name})`,
				);
		}
		// Nothing left running is a failed run, not one quietly waiting on
		// restarts nobody will ask for.
		const down = new Set([
			...readinessFailures.keys(),
			...exited,
			...failed.map(([name]) => name),
		]);
		if (Object.keys(startable).every((name) => down.has(name)))
			throw failed[0]?.[1];

		for (const [name, error] of failed) await parkFailedApp(name, error);
		return healthy;
	}

	/** Its row (stream or TUI) says it failed and how to restart it. */
	async function parkFailedApp(name: string, error: Error): Promise<void> {
		readinessFailures.set(name, error.message);
		optional.add(name);
		await session.stopApp(name);
		options.onAppFailed?.(name, error);
	}
	try {
		// Each layer is healthy before the next spawns: that is `startAfter`.
		for (const layer of order.beforeTunnels) await startWave(layer);
		if (onAfterWave1) {
			await owner.race(onAfterWave1(owner.controller.signal));
		}

		for (const layer of order.afterTunnels) await startWave(layer);
		owner.controller.signal.throwIfAborted();

		// After startup, so a save mid-start cannot race the first health check.
		// Only apps this run spawned: a reused one has nothing here to restart.
		if (options.watch !== false)
			for (const [name, config] of Object.entries(startable))
				if (config.watch && pids[name] !== undefined)
					watchApp({
						name,
						dir: config.cwd ? resolve(root, config.cwd) : root,
						config: config.watch,
						signal: owner.controller.signal,
						onChange: (reason) => {
							void restartApp(name, reason).catch(() => {});
						},
					});
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
