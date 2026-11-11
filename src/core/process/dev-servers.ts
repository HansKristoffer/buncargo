import { resolve } from "node:path";
import { anySignal, mapValues, typedSwitch } from "hanzio";
import type { ContainerRuntimeAdapter } from "../../container-runtime/types";
import type { AppConfig, DevServerPids } from "../../types";
import { abortableSleep, abortError } from "../deadline";
import { readEnvOverrides, warnShadowedSecrets } from "../env-overrides";
import { waitForDevServers } from "../network";
import { loadAppSecrets, missingRequiredSecrets } from "../secrets/infisical";
import {
	formatPidLine,
	formatStep,
	formatWait,
	formatWarn,
	prefixWidth,
	SLOW_STEP_MS,
} from "../style";
import {
	type AppEvent,
	AppFailure,
	type AppLife,
	appState,
	RunInterrupted,
} from "./app-lifecycle";
import {
	ptyTeeArgv,
	resolveStartCommand,
	runPrebuild,
	spawnManagedApp,
} from "./app-process";
import { AppSupervision } from "./app-supervision";
import { watchApp } from "./app-watch";
import { createCaptureRestarts } from "./capture-restarts";
import {
	type CapturedValue,
	createOutputCaptureScanner,
} from "./output-capture";
import {
	type DriftProbe,
	systemDriftProbe,
	watchPortDrift,
} from "./port-drift";
import {
	classifyPortOccupant,
	createPortOwnerSnapshotAsync,
	formatPortOwner,
	getPortOwner,
	killPortOwner,
	type PortOwnerSnapshot,
} from "./port-owner";
import { printStream, RunOutput } from "./run-output";
import { planSpawnOrder } from "./start-order";
import { spawnOwnedWorker } from "./worker-ownership";

export { stopDevServers } from "./app-supervision";

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
	verbose?: boolean;
	productionBuild?: boolean;
	/** Compose/project name used to classify port occupants. */
	projectName?: string;
	/** App that owns the TTY. Others get prefixed pipes. Ignored by the TUI. */
	attach?: string;
	/**
	 * Where app output goes. Default: prefixed lines on stdout. The TUI passes
	 * one whose `terminals` are `pty`, which gives every app its own terminal.
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
	/** Called once when the run is interrupted: SIGINT/SIGTERM/SIGHUP, or the attached app quit (waitForExit only). */
	onSignal?: () => void | Promise<void>;
	/**
	 * Override the health check, which is asked for one app at a time: the
	 * app is ready when it resolves. Quiet: the run reports readiness itself.
	 */
	waitForHealth?: (
		apps: Record<string, AppConfig>,
		signal?: AbortSignal,
		onAppReady?: (name: string) => void,
	) => Promise<void>;
	/**
	 * Every step of an app's life (`app-lifecycle.ts`): spawned (a new
	 * `pid`), reused, ready, restarting, down with its verdict. The rows, the
	 * logs and the run registry read the same value, so they agree.
	 *
	 * Its return value is awaited only for `restarting`, before the new
	 * process spawns; nothing else about starting servers may wait on it.
	 */
	onAppPhase?: (
		name: string,
		life: AppLife,
		previous: AppLife,
	) => void | Promise<void>;
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
	 * An app that does not become ready is stopped and the others keep
	 * running, unless a later app `startAfter`s it. Default: false, the run
	 * ends - what `ci` and a library `start()` want. `buncargo dev` turns it on.
	 */
	keepOthersOnFailure?: boolean;
	/** Start the apps' `watch` watchers. Default: true; `dev --no-watch` passes false. */
	watch?: boolean;
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
		reuse: () => "reuse",
		fail: () => {
			if (owner) {
				const held = formatPortOwner(port, owner, { runtime: runtime?.name });
				throw new AppFailure(name, "start", held);
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
				const stopIt =
					holder.pids.length > 0
						? `Stop it with \`kill ${holder.pids.join(" ")}\``
						: "Stop it";
				const refusal = `${name} cannot start: ${held}, which did not stop when buncargo stopped the leftover process on it. ${stopIt}, then start again.`;
				throw new AppFailure(name, "start", refusal);
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

/** How an app shows it is ready. */
function readinessCheck(config: AppConfig): "output" | "health" | "none" {
	if (config.readyWhen !== undefined) return "output";
	if (config.kind === "worker" || config.healthEndpoint === false)
		return "none";
	return "health";
}

/** The run's own interruption: a Ctrl-C (or SIGTERM, SIGHUP) to this process. */
function interruptOnSignals(): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const interrupt = () =>
		controller.abort(new RunInterrupted("Run interrupted"));
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	for (const signal of signals) process.on(signal, interrupt);
	return {
		signal: controller.signal,
		dispose: () => {
			for (const signal of signals) process.off(signal, interrupt);
		},
	};
}

function toAppFailure(name: string, error: unknown): AppFailure {
	if (error instanceof AppFailure) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new AppFailure(name, "not-ready", message, { cause: error });
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
	const output = options.output ?? new RunOutput({ terminals: "pipe" });
	const stopPrinting = options.output
		? undefined
		: printStream(output, { width: nameWidth });
	const closeOwnOutput = async () => {
		if (options.output) return;
		await output.close();
		stopPrinting?.();
	};
	// Under pseudo-terminals every app has a terminal of its own: none needs the real one.
	const configuredInteractive =
		output.terminals === "pty"
			? undefined
			: Object.entries(startable).find(([, app]) => app.interactive)?.[0];
	const attachedName = attachOverride ?? configuredInteractive;
	if (attachOverride && !startable[attachOverride]) {
		throw new Error(`--attach=${attachOverride} is not in the start set`);
	}

	const interrupts = interruptOnSignals();
	const supervisor = new AppSupervision(
		mapValues(startable, (config, name) => ({
			optional: config.essential === false,
			worker: config.kind === "worker",
			checked: readinessCheck(config) !== "none",
			attached: name === attachedName,
			port: config.kind === "worker" ? undefined : ports[name],
			graceMs: config.stopGraceMs,
			startAfter: config.startAfter,
		})),
		{
			signal: anySignal(options.signal, interrupts.signal),
			shutdownGraceMs: options.shutdownGraceMs,
			keepOthersOnFailure: options.keepOthersOnFailure,
			onPhase: (name, life, previous, event) => {
				showPhase(name, life, previous, event);
				return options.onAppPhase?.(name, life, previous);
			},
			onNotice: (name, text) =>
				output.announce(name, text, { raw: formatWarn(text), level: "warn" }),
		},
	);
	const pids = supervisor.pids;
	let handedOff = false;

	/** The rows: stream mode, the TUI and the log files, through `output`. */
	function showPhase(
		name: string,
		life: AppLife,
		previous: AppLife,
		event: AppEvent,
	): void {
		if (verbose && life.pid !== undefined && life.pid !== previous.pid)
			output.announce(name, `PID: ${life.pid}`, {
				raw: formatPidLine(name, life.pid, nameWidth),
			});
		if (event.type === "restarting") {
			const text = `restarting: ${event.reason}`;
			output.announce(name, text, {
				raw: formatStep(`🔁 Restarting ${name}: ${event.reason}`),
			});
		}
		// The run is ending: its rows stay as they were.
		if (event.type === "exited" && event.runEnding) return;
		const show = () => {
			// Read when shown: parking may have decided more since, and a
			// newer process's row is not this one's to change.
			const now = supervisor.life(name);
			if (now.generation !== life.generation) return;
			const state = appState(now);
			const shown = output.states.get(name);
			const same =
				shown?.state === state.state &&
				shown.detail === state.detail &&
				shown.restartable === state.restartable;
			if (!same) output.state(name, state);
		};
		// After the app's last screen, so its final words precede the verdict.
		const screen = output.screens.get(name);
		if (event.type === "exited" && screen) void screen.flush().then(show);
		else show();
	}

	// A replaced app is ready again the way it was the first time: checked
	// on the side, so a failing restart never stalls the others.
	const restartApp = async (name: string, reason?: string) => {
		if (await supervisor.restart(name, reason)) checkOnTheSide(name, true);
	};
	output.controls = { restart: (name) => restartApp(name, "requested") };

	const scannerFor = createCaptureRestarts(startable, {
		signal: supervisor.signal,
		onCapture: (app, captured) => {
			output.capture(app, captured);
			return onCapture?.(app, captured) ?? [];
		},
		restart: (name) => restartApp(name),
	});

	/** Spared if it goes down now: `essential: false`, on probation, or parked. */
	const spared = (name: string) =>
		supervisor.life(name).standing !== "essential";

	async function spawnWave(
		wave: Record<string, AppConfig>,
		probation: (name: string) => boolean,
	): Promise<void> {
		// Per wave, not per run: a later wave spawns after tunnels have opened
		// and earlier servers have bound their ports, so a snapshot taken before
		// the first wave would be describing a machine that has since changed.
		supervisor.signal.throwIfAborted();
		const portOwners = await createPortOwnerSnapshotAsync({
			signal: supervisor.signal,
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
			supervisor.signal.throwIfAborted();
			if (prepared === "start") {
				toStart.push([name, config]);
				continue;
			}
			if (verbose) {
				const text = `♻️  Reusing existing process on port ${ports[name]} (${name})`;
				output.announce(name, text, { raw: formatStep(text) });
			}
			supervisor.reuse(name, probation(name));
		}

		// A wave's prebuilds run side by side, and all finish before any of its
		// apps spawns: a watcher's first rebuild must not race its own build.
		await supervisor.race(
			Promise.all(
				toStart.map(([name, config]) =>
					runPrebuild(name, config, root, appEnv(name), {
						signal: supervisor.signal,
						output,
						graceMs: options.shutdownGraceMs,
					}),
				),
			),
		);

		for (const [name, config] of toStart) {
			const attached = name === attachedName;
			const onText = scannerFor(name, config);
			const unreadCaptures =
				attached &&
				onText !== undefined &&
				output.terminals === "pipe" &&
				process.stdin.isTTY &&
				!ptyTeeArgv("");
			if (unreadCaptures) {
				const text = `${name}'s captures are not read: no \`script\` command to run it under a terminal.`;
				output.announce(name, text, { raw: formatWarn(text), level: "warn" });
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
			const spawnApp = (onProbation = false) =>
				config.kind === "worker"
					? spawnOwnedWorker(root, name, spawnOnce, supervisor.signal, {
							allowEarlyExit: onProbation || spared(name),
						})
					: Promise.resolve(spawnOnce());
			supervisor.setSpawner(name, () => spawnApp());
			const child = await spawnApp(probation(name));
			await supervisor.register(name, child, {
				probation: probation(name),
			});
		}
	}

	// `readyWhen`: one promise per process, resolved when its output matches.
	// A fresh scanner per spawn, so a restart waits for the line again; the
	// app's own captures keep theirs, which report a value only when it changes.
	const printedReady = new Map<string, Promise<void>>();
	function watchForReady(
		name: string,
		config: AppConfig,
		onText: ((text: string) => void) | undefined,
	): ((text: string) => void) | undefined {
		if (!config.readyWhen) return onText;
		const printed = Promise.withResolvers<void>();
		printedReady.set(name, printed.promise);
		const scanner = createOutputCaptureScanner({
			ready: { pattern: config.readyWhen, as: "event" },
		});
		let seen = false;
		return (text) => {
			onText?.(text);
			if (!seen && scanner.push(text).length > 0) {
				seen = true;
				printed.resolve();
			}
		};
	}

	async function waitForPrinted(
		name: string,
		config: AppConfig,
		signal: AbortSignal,
	): Promise<void> {
		const printed = printedReady.get(name);
		if (!printed) return;
		const timeoutMs = config.healthTimeout ?? 60_000;
		const done = new AbortController();
		const seconds = Math.round(timeoutMs / 1000);
		const timedOut = `${name} did not print ${config.readyWhen} within ${seconds}s`;
		try {
			await Promise.race([
				printed,
				abortableSleep(timeoutMs, anySignal(signal, done.signal)).then(() => {
					throw new Error(timedOut);
				}),
			]);
		} finally {
			done.abort();
		}
	}

	/**
	 * One readiness wait per process, shared by its wave, the sparing of the
	 * others and the side checks. The app is marked ready the moment it
	 * resolves; it rejects with an `AppFailure` once it cannot be, its process
	 * exiting included.
	 */
	const readiness = new Map<
		string,
		{ generation: number; ready: Promise<void>; fail(error: Error): void }
	>();
	function appReady(name: string): Promise<void> {
		const life = supervisor.life(name);
		const known = readiness.get(name);
		if (known?.generation === life.generation) return known.ready;
		const config = startable[name];
		const processSignal = supervisor.processSignal(name);
		const signal = anySignal(supervisor.signal, processSignal);
		const failed = Promise.withResolvers<never>();
		const reused = life.phase === "reused";
		const check = (async () => {
			signal.throwIfAborted();
			const kind = readinessCheck(config);
			// Reused from another run: nothing of ours to read.
			if (kind === "output" && !reused)
				await waitForPrinted(name, config, signal);
			if (kind === "health") await health({ [name]: config }, signal);
			signal.throwIfAborted();
		})();
		const ready = Promise.race([check, failed.promise]).then(
			() => {
				supervisor.ready(name, life.generation);
			},
			(error) => {
				if (supervisor.signal.aborted) throw abortError(supervisor.signal);
				throw toAppFailure(
					name,
					processSignal.aborted ? processSignal.reason : error,
				);
			},
		);
		void ready.catch(() => {});
		readiness.set(name, {
			generation: life.generation,
			ready,
			fail: failed.reject,
		});
		return ready;
	}

	function health(
		app: Record<string, AppConfig>,
		signal: AbortSignal,
	): Promise<void> {
		if (waitForHealth) return waitForHealth(app, signal);
		return waitForDevServers(app, ports, {
			verbose: false,
			logReady: false,
			productionBuild,
			signal,
		});
	}

	// An app that drifted to another port fails now rather than when its
	// health check times out. One watcher per wave (or side check), over
	// whichever of its apps are still coming up.
	const driftProbe =
		options.portDrift === false
			? undefined
			: (options.portDrift ?? systemDriftProbe({ root, projectName }));
	function watchDrift(names: readonly string[]): AbortController {
		const done = new AbortController();
		if (!driftProbe) return done;
		// Spawned by this run, listening on a port, and still coming up.
		const targets = () =>
			names.flatMap((name) => {
				const { phase, pid, generation } = supervisor.life(name);
				const config = startable[name];
				const port = ports[name];
				const listens =
					config?.kind !== "worker" && config?.healthEndpoint !== false;
				const checking = readiness.get(name)?.generation === generation;
				if (!listens || !checking || phase !== "starting") return [];
				if (pid === undefined || port === undefined) return [];
				return [{ name, pid, port }];
			});
		void watchPortDrift(
			targets,
			driftProbe,
			anySignal(supervisor.signal, done.signal),
			(name, message) =>
				readiness.get(name)?.fail(new AppFailure(name, "not-ready", message)),
		);
		return done;
	}

	/**
	 * A non-essential app, or a restarted one, is checked on the side, one
	 * check per process: its exit or replacement ends the check quietly (the
	 * exit is reported), so a check that outlives the process cannot report
	 * the next one (or a dead one) as ready. One that fails parks the app, or
	 * ends the run as it would have at start.
	 */
	function checkOnTheSide(name: string, ownDriftWatch: boolean): void {
		if (supervisor.signal.aborted) return;
		const processSignal = supervisor.processSignal(name);
		const drift = ownDriftWatch ? watchDrift([name]) : undefined;
		void appReady(name)
			.catch((error) => {
				if (supervisor.signal.aborted || processSignal.aborted) return;
				return supervisor.fail([toAppFailure(name, error)]);
			})
			.catch((error) => supervisor.controller.abort(error))
			.finally(() => drift?.abort());
	}

	async function startWave(wave: Record<string, AppConfig>): Promise<void> {
		const names = Object.keys(wave);
		if (names.length === 0) return;
		const spareOthers = options.keepOthersOnFailure === true;
		const essential = names.filter(
			(name) => supervisor.life(name).standing !== "optional",
		);
		// Until it is up, an essential app's crash parks it rather than ending
		// the run. Not the attached app: quitting it ends the run, booted or not.
		const probation = (name: string) =>
			spareOthers && essential.includes(name) && name !== attachedName;
		await spawnWave(wave, probation);

		const drift = watchDrift(names);
		const slowWait = verbose
			? setTimeout(() => {
					const text = "Waiting for servers to be ready...";
					output.announce("buncargo", text, { raw: formatWait(text) });
				}, SLOW_STEP_MS)
			: undefined;
		try {
			// A non-essential app never holds the run up.
			for (const name of names)
				if (!essential.includes(name)) checkOnTheSide(name, false);
			// A worker or `healthEndpoint: false` app without `readyWhen` is
			// ready once the rest of its wave is: spared only while it comes up.
			const checked = essential.filter(
				(name) => readinessCheck(startable[name]) !== "none",
			);
			const unchecked = essential.filter((name) => !checked.includes(name));
			const waits = (group: readonly string[]) =>
				spareOthers
					? supervisor.race(Promise.allSettled(group.map(appReady)))
					: supervisor.race(Promise.all(group.map(appReady))).then(() => []);
			const waited = [...checked, ...unchecked];
			const results = [...(await waits(checked)), ...(await waits(unchecked))];
			const failures = results.flatMap((result, index) =>
				result.status === "rejected"
					? [toAppFailure(waited[index], result.reason)]
					: [],
			);
			await supervisor.fail(failures);
		} catch (error) {
			// The run's end, or the first app that did not come up.
			if (!supervisor.signal.aborted && error instanceof AppFailure)
				await supervisor.fail([error]);
			throw supervisor.signal.aborted ? abortError(supervisor.signal) : error;
		} finally {
			clearTimeout(slowWait);
			drift.abort();
		}
		supervisor.signal.throwIfAborted();
	}

	try {
		// Each layer is ready before the next spawns: that is `startAfter`.
		for (const layer of order.beforeTunnels) await startWave(layer);
		if (onAfterWave1) {
			await supervisor.race(onAfterWave1(supervisor.signal));
		}

		for (const layer of order.afterTunnels) await startWave(layer);
		supervisor.signal.throwIfAborted();

		// After startup, so a save mid-start cannot race the first health check.
		// Only apps this run spawned: a reused one has nothing here to restart.
		if (options.watch !== false)
			for (const [name, config] of Object.entries(startable))
				if (config.watch && pids[name] !== undefined)
					watchApp({
						name,
						dir: config.cwd ? resolve(root, config.cwd) : root,
						config: config.watch,
						signal: supervisor.signal,
						onChange: (reason) => {
							void restartApp(name, reason).catch(() => {});
						},
					});
		if (options.onReady) {
			await supervisor.race(
				Promise.resolve().then(() => options.onReady?.(supervisor.signal)),
			);
		}

		if (waitForExit) {
			await supervisor.wait();
			await supervisor.stop();
		} else {
			handedOff = true;
			const closing = (async () => {
				try {
					await supervisor.wait();
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
						await supervisor.stop();
					} finally {
						interrupts.dispose();
						await closeOwnOutput();
					}
				}
			})().catch((error) => console.error(error));
			supervisor.closeWith(closing);
		}

		return pids;
	} catch (error) {
		try {
			await supervisor.stop();
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
			supervisor.dispose();
			interrupts.dispose();
			await closeOwnOutput();
		}
	}
}
