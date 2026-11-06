import { resolve } from "node:path";
import { anySignal, toError, typedSwitch } from "hanzio";
import type { ContainerRuntimeAdapter } from "../../container-runtime/types";
import type { AppConfig, DevServerPids } from "../../types";
import { abortableSleep } from "../deadline";
import { readEnvOverrides, warnShadowedSecrets } from "../env-overrides";
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
	getPortOwner,
	killPortOwner,
	type PortOwnerSnapshot,
} from "./port-owner";
import { appExitState, RunInterrupted } from "./process-owner";
import { type AppStateDetail, printStream, RunOutput } from "./run-output";

export { stopDevServers } from "./app-supervision";

import { watchApp } from "./app-watch";
import {
	type DriftProbe,
	systemDriftProbe,
	watchPortDrift,
} from "./port-drift";
import { planSpawnOrder } from "./start-order";
import { spawnOwnedWorker } from "./worker-ownership";

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
	/** Compose/project name used to classify port occupants. */
	projectName?: string;
	/** App that owns the TTY. Others get prefixed pipes. Ignored by the TUI. */
	attach?: string;
	/**
	 * Where app output goes. Default: prefixed lines on stdout. The TUI passes
	 * one with `terminalSize` set, which gives every app its own terminal.
	 * One passed in is the caller's to close.
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
	/**
	 * Override the health wait of each wave. Call `onAppReady` as each app
	 * comes up, so it is marked ready then rather than with the whole wave.
	 */
	waitForHealth?: (
		apps: Record<string, AppConfig>,
		signal?: AbortSignal,
		onAppReady?: (name: string) => void,
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
	 * a `buncargo stop <app>` or a Ctrl-C looks like from here. `state` is how
	 * it ended, as the run registry records it: `failed` for an app stopped
	 * because it never came up, whatever the signal.
	 */
	onAppExit?: (
		name: string,
		code: number | null,
		signal: NodeJS.Signals | null | undefined,
		state: "stopped" | "failed",
	) => void;
	/**
	 * An app that does not become ready is stopped and the others keep
	 * running, unless a later app `startAfter`s it. Default: false, the run
	 * ends - what `ci` and a library `start()` want. `buncargo dev` turns it on.
	 */
	keepOthersOnFailure?: boolean;
	/** Start the apps' `watch` watchers. Default: true; `dev --no-watch` passes false. */
	watch?: boolean;
	/**
	 * An app did not become ready and is stopped (see above). Reported before
	 * the stop, so its exit is never the first word on it.
	 */
	onAppFailed?: (name: string, error: Error) => void;
	/**
	 * A restart of the app has begun: its row says `starting` until the new
	 * process is ready. Never for a restart asked for after the run ended.
	 */
	onAppRestarting?: (name: string) => void;
	/**
	 * A restart retired the app's process and could not replace it: the app
	 * is down until restarted again. Reported once, like an exit, so the run
	 * registry stops saying `starting`.
	 */
	onAppRestartFailed?: (name: string, error: Error) => void;
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
	graceMs: number | undefined,
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
	return typedSwitch(action, {
		reuse: () => {
			if (verbose) {
				console.log(
					formatStep(`♻️  Reusing existing process on port ${port} (${name})`),
				);
			}
			return "reuse";
		},
		fail: () => {
			if (owner) {
				throw new Error(
					formatPortOwner(port, owner, { runtime: runtime?.name }),
				);
			}
			return "start";
		},
		kill: async (): Promise<"start"> => {
			const released = await killPortOwner(port, {
				verbose,
				runtime,
				skipContainers,
				timeout: graceMs,
			});
			// `false` is also "it was gone before it could be stopped".
			const holder = released
				? null
				: getPortOwner(port, { runtime, skipContainers });
			if (holder) {
				const held = formatPortOwner(port, holder, { runtime: runtime?.name });
				throw new Error(
					`${name} cannot start: ${held}, which did not stop when buncargo stopped the leftover process on it. Stop it yourself, then start again.`,
				);
			}
			return "start";
		},
		free: () => "start",
	});
}

/** The apps that have a command to run in this mode. */
export function startableApps(
	apps: Record<string, AppConfig>,
	productionBuild: boolean,
): Record<string, AppConfig> {
	return Object.fromEntries(
		Object.entries(apps).filter(
			([, app]) => resolveStartCommand(app, productionBuild) !== undefined,
		),
	);
}

/**
 * The apps' Infisical secrets, refusing with one error naming every missing
 * required key per app rather than each app crashing on its own first read of
 * one. Lowest precedence: the app's computed env (`appEnv`) is layered on top,
 * and `loadAppSecrets` drops keys the developer already exported.
 * Fetches are cached per scope, so a second call costs nothing, and no app
 * declaring a scope spawns nothing.
 */
export async function loadStartSecrets(
	apps: Record<string, AppConfig>,
	appEnv: (name: string) => Record<string, string>,
	options: { signal?: AbortSignal; onWait?: (ms: number) => void } = {},
): Promise<Record<string, Record<string, string>>> {
	const secrets = await loadAppSecrets(apps, options);
	const missing = missingRequiredSecrets(apps, (name) => ({
		...process.env,
		...secrets[name],
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
	return secrets;
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

	const startable = startableApps(apps, productionBuild);
	// Here rather than in the environment layer because this is the one function
	// every spawner goes through: `startAppServers` and the CLI's own dev flow
	// both land here, and a third caller cannot miss it. Lowest precedence — the
	// app's computed env is layered on top, and `loadAppSecrets` drops keys the
	// developer already exported.
	const secrets = await loadStartSecrets(
		startable,
		(name) => resolveAppEnv(envVarsByApp, name),
		{
			signal: options.signal,
			onWait: (ms) => options.onPhase?.("secrets", ms),
		},
	);
	warnShadowedSecrets(
		root,
		readEnvOverrides(root),
		Object.values(secrets).flatMap((values) => Object.keys(values)),
	);
	const appEnv = (name: string) => ({
		...secrets[name],
		...resolveAppEnv(envVarsByApp, name),
	});

	const order = planSpawnOrder(startable, deferPublicUrlApps);
	const nameWidth = prefixWidth(Object.keys(startable));
	const output = options.output ?? new RunOutput();
	const stopPrinting = options.output
		? undefined
		: printStream(output, { width: nameWidth });
	const closeOwnOutput = async () => {
		if (options.output) return;
		await output.close();
		stopPrinting?.();
	};
	// In the TUI every app has a terminal of its own: none needs the real one.
	const configuredInteractive = output.terminalSize
		? undefined
		: Object.entries(startable).find(([, app]) => app.interactive)?.[0];
	const attachedName = attachOverride ?? configuredInteractive;
	if (attachOverride && !startable[attachOverride]) {
		throw new Error(`--attach=${attachOverride} is not in the start set`);
	}
	// Whose exit ends the run. Never an `essential: false` app's. An essential
	// app is spared while on probation (it has not come up yet, in a wave
	// that spares the others) and once parked (it never came up), until it is
	// ready again: restart, the TUI and the registry need nothing new.
	const optional: ReadonlySet<string> = new Set(
		Object.entries(startable)
			.filter(([, app]) => app.essential === false)
			.map(([name]) => name),
	);
	const probation = new Set<string>();
	const parked = new Set<string>();
	const isOptional = (name: string) =>
		optional.has(name) || probation.has(name) || parked.has(name);
	// What its row offers. Probation is undecided: a run about to fail must
	// not say that the rest keeps going.
	const restartable = (name: string) => optional.has(name) || parked.has(name);
	// Apps whose current process has exited. Recorded the moment the exit is
	// seen, not when it is shown (that waits for the app's last screen), so
	// no readiness check can report a dead process ready in between.
	const exited = new Set<string>();
	// Per process: aborted, with how, when it exits.
	const exits = new Map<string, AbortController>();
	// Apps stopped because they never became ready, and why.
	const readinessFailures = new Map<string, string>();
	// Apps another process serves (`prepareAppPort` reused it): nothing of
	// this run's to stop or restart.
	const reused = new Set<string>();
	// Bumped by every spawn and restart: what is shown about one process
	// never lands on the next. `endShown` is the generation whose end is.
	const generations = new Map<string, number>();
	const endShown = new Map<string, number>();
	function showEnd(
		name: string,
		generation: number | undefined,
		end: AppStateDetail,
		again = false,
	): void {
		if (generations.get(name) !== generation) return;
		if (!again && endShown.get(name) === generation) return;
		if (generation !== undefined) endShown.set(name, generation);
		output.state(name, end);
	}
	const nextGeneration = (name: string) =>
		generations.set(name, (generations.get(name) ?? 0) + 1);

	const session = new AppSupervision({
		signal: options.signal,
		shutdownGraceMs: options.shutdownGraceMs,
		appGraceMs: new Map(
			Object.entries(startable).flatMap(([name, app]) =>
				app.stopGraceMs === undefined ? [] : [[name, app.stopGraceMs]],
			),
		),
		attachedName,
		isOptional,
		onAppExit: (name, code, signal) => {
			exited.add(name);
			sideChecks.get(name)?.abort();
			const how = signal ? `signal ${signal}` : `code ${code}`;
			exits.get(name)?.abort(new Error(`App "${name}" exited with ${how}`));
			if (!owner.controller.signal.aborted) {
				const generation = generations.get(name);
				// After the app's last screen, so its final words precede the
				// verdict, which is read then: parking may have decided it since.
				const report = () => {
					const failure = readinessFailures.get(name);
					const state = failure
						? "failed"
						: appExitState(code, signal, {
								worker: startable[name]?.kind === "worker",
								optional: isOptional(name),
							});
					const detail =
						failure ?? (signal ? `signal ${signal}` : `exit ${code}`);
					showEnd(name, generation, {
						state,
						detail,
						restartable: restartable(name),
					});
				};
				const screen = output.screens.get(name);
				if (screen) void screen.flush().then(report);
				else report();
			}
			// The registry's verdict, decided now rather than after the screen:
			// an app stopped for never coming up was reported failed already.
			const state = readinessFailures.has(name)
				? "failed"
				: appExitState(code, signal, {
						worker: startable[name]?.kind === "worker",
						optional: restartable(name),
					});
			onAppExit?.(name, code, signal, state);
		},
		onAppSpawned: (name, pid, attached) => {
			exited.delete(name);
			exits.set(name, new AbortController());
			nextGeneration(name);
			// A ready app reporting a new pid adopted its detached server.
			if (output.states.get(name)?.state !== "ready")
				output.state(name, { state: "starting" });
			onAppSpawned?.(name, pid, attached);
		},
		// Only once the restart begins: one that never does (the run is
		// ending) leaves the row as it was.
		onRestart: (name, reason) => {
			nextGeneration(name);
			readinessFailures.delete(name);
			sideChecks.get(name)?.abort();
			output.state(name, { state: "starting" });
			options.onAppRestarting?.(name);
			output.event(name, `restarting: ${reason}`);
			if (!output.terminalSize)
				console.log(formatStep(`🔁 Restarting ${name}: ${reason}`));
		},
		onRestartFailed: (name, error) => {
			// Gone like an app that exited, so no wait for it holds on.
			exited.add(name);
			exits.get(name)?.abort(error);
			// Down like one that never came up: parked when the others are spared.
			if (options.keepOthersOnFailure) parked.add(name);
			output.state(name, {
				state: "failed",
				detail: `restart failed: ${error.message}`,
				restartable: restartable(name),
			});
			options.onAppRestartFailed?.(name, error);
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
		if (await session.restart(name, reason)) checkOnTheSide(name);
	};
	output.controls = { restart: (name) => restartApp(name, "requested") };
	const markReady = (name: string) => {
		if (exited.has(name)) return;
		owner.ready(name);
		// Only a starting app becomes ready; an exited one stays as it ended.
		if (output.states.get(name)?.state !== "starting") return;
		// Up: from here its exit is an essential app falling over again.
		probation.delete(name);
		parked.delete(name);
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
				config.stopGraceMs,
				root,
				projectName,
				verbose,
				portOwners,
				options.runtime,
				options.skipContainers,
			);
			owner.controller.signal.throwIfAborted();
			if (prepared === "start") toStart.push([name, config]);
			else {
				// Its row comes up like a spawned app's: readiness promotes it.
				reused.add(name);
				output.state(name, { state: "starting" });
			}
		}

		// A wave's prebuilds run side by side, and all finish before any of its
		// apps spawns: a watcher's first rebuild must not race its own build.
		await owner.race(
			Promise.all(
				toStart.map(([name, config]) =>
					runPrebuild(name, config, root, appEnv(name), {
						signal: owner.controller.signal,
						output,
						graceMs: options.shutdownGraceMs,
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
				? waitForHealth(wave, signal, ready)
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
			anySignal(signal, done.signal),
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
						abortableSleep(timeoutMs, anySignal(signal, done.signal)).then(
							() => {
								throw new Error(
									`${name} did not print ${config.readyWhen} within ${Math.round(timeoutMs / 1000)}s`,
								);
							},
						),
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
		const signal = anySignal(owner.controller.signal, controller.signal);
		void waitForWave({ [name]: config }, signal)
			.catch((error) => {
				// Its process ended or was replaced, or the run is ending.
				if (signal.aborted) return;
				return sideCheckFailed(name, toError(error));
			})
			.catch((error) => owner.controller.abort(error));
	}

	/**
	 * A process checked on the side never came up. An optional app, or any
	 * app when the others are spared, is stopped and parked like one that
	 * never came up at start; otherwise the run fails, as it would have then.
	 */
	async function sideCheckFailed(name: string, error: Error): Promise<void> {
		if (isOptional(name) || options.keepOthersOnFailure)
			await parkFailedApp(name, error);
		else owner.controller.abort(error);
	}

	async function startWave(wave: Record<string, AppConfig>): Promise<void> {
		if (Object.keys(wave).length === 0) {
			return;
		}

		let essential = Object.fromEntries(
			Object.entries(wave).filter(([name]) => !optional.has(name)),
		);
		// Before any spawns: one that crashes at boot is parked, not the run's
		// end. Not the attached app: quitting it ends the run, booted or not.
		if (options.keepOthersOnFailure)
			for (const name of Object.keys(essential))
				if (name !== attachedName) probation.add(name);
		await spawnWave(wave);
		// A non-essential app never holds the run up: it is health-checked on
		// the side, and its failing to come up is its own problem.
		for (const name of Object.keys(wave).filter((name) => optional.has(name)))
			checkOnTheSide(name);
		if (options.keepOthersOnFailure) {
			essential = await spareHealthyApps(essential);
			// Up: a crash from here ends the run at once, rather than leaving
			// the wave's readiness wait to time out on a parked app.
			for (const name of Object.keys(essential)) probation.delete(name);
		}
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
		const results = await owner.race(
			Promise.allSettled(
				Object.entries(wave).map(([name, config]) => {
					// Ends the moment its process exits: a crash at boot is not
					// waited out to its health timeout.
					const signal = anySignal(
						owner.controller.signal,
						exits.get(name)?.signal,
					);
					return raceDrift(
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
					);
				}),
			),
		);
		owner.controller.signal.throwIfAborted();

		const healthy: Record<string, AppConfig> = {};
		const failed: [string, Error][] = [];
		for (const [index, [name, config]] of Object.entries(wave).entries()) {
			const result = results[index];
			// A worker is ready once spawned, so only its exit says it failed.
			const exit = exited.has(name) ? exits.get(name)?.signal : undefined;
			if (exit) failed.push([name, toError(exit.reason)]);
			else if (result?.status === "fulfilled") healthy[name] = config;
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

	/**
	 * Stop an app that never came up, and spare it until a restart brings it
	 * up. Its row (stream or TUI) says it failed and how to restart it.
	 */
	async function parkFailedApp(name: string, error: Error): Promise<void> {
		readinessFailures.set(name, error.message);
		probation.delete(name);
		parked.add(name);
		// Before the stop below, whose exit then says it failed too: the run
		// registry keeps an app's `stopped` over a later `failed`.
		options.onAppFailed?.(name, error);
		if (reused.has(name)) {
			// Neither stopped nor restartable from here: say so rather than
			// report a process that keeps running as failed and parked.
			const detail = `${error.message}; served by a process this run did not start, which is left running`;
			output.state(name, { state: "failed", detail, restartable: false });
			if (!output.terminalSize) console.warn(formatWarn(`${name}: ${detail}`));
		} else if (exited.has(name)) {
			// Its exit may be on screen already, read before it was parked.
			showEnd(
				name,
				generations.get(name),
				{
					state: "failed",
					detail: error.message,
					restartable: restartable(name),
				},
				true,
			);
		} else {
			// Its exit reports it, with the reason above.
			await session.stopApp(name);
		}
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
			const closing = (async () => {
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
						await closeOwnOutput();
					}
				}
			})().catch((error) => console.error(error));
			session.closeWith(closing);
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
			await closeOwnOutput();
		}
	}
}
