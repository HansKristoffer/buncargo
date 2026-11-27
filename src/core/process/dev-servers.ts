import { resolve } from "node:path";
import { anySignal, mapValues, pick, toError, typedSwitch } from "hanzio";
import type { ContainerRuntimeAdapter } from "../../container-runtime/types";
import type { ResolvedApp, TaskConfig } from "../../types";
import { abortableSleep, abortError } from "../deadline";
import { readEnvOverrides, warnShadowedSecrets } from "../env-overrides";
import { waitForDevServers } from "../network";
import { loadAppSecrets, missingRequiredSecrets } from "../secrets/index";
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
	resolveStartCommand,
	runPrebuild,
	spawnManagedApp,
} from "./app-process";
import { AppSupervision, type SupervisedApp } from "./app-supervision";
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
	getPortOwnerAsync,
	killPortOwner,
	type PortOwnerSnapshot,
} from "./port-owner";
import { ReactiveTaskRunner } from "./reactive-tasks";
import { printStream, RunOutput } from "./run-output";
import { planSpawnOrder } from "./start-order";
import { spawnOwnedWorker } from "./worker-ownership";

export { stopDevServers } from "./app-supervision";

/** Work triggered once named apps are ready (such as post-app seeding). */
export interface AfterAppsTask {
	/** Short label for failure reasons (`"seed"`). */
	label: string;
	/** Apps that must be ready before `run` starts. */
	apps: readonly string[];
	/**
	 * When true, remaining apps wait for `run` to finish before spawning.
	 * When false, `run` starts as soon as `apps` are ready and overlaps the
	 * remaining apps, settling before `onReady`.
	 */
	beforeOtherApps: boolean;
	run: (signal: AbortSignal) => Promise<void>;
}

/** Reactive one-shot tasks (`onAppReady` / `watch`) supervised alongside dev servers. */
interface ReactiveTasksInput {
	tasks: Readonly<Record<string, TaskConfig>>;
	/** Full configured apps map so `task.app` resolves its default `cwd` even when reused. */
	apps?: Readonly<Record<string, Pick<ResolvedApp, "cwd">>>;
	buildEnv: (
		task: TaskConfig,
		signal: AbortSignal,
	) => Record<string, string> | Promise<Record<string, string>>;
	/** Apps already running and healthy before this session spawned (e.g. reused apps). */
	initialReadyApps?: readonly string[];
}

export interface StartDevServersOptions {
	onPhase?: (name: string, ms: number) => void;
	/** Reports a supervised failure after a library start returned its pids. */
	onFailure?: (error: unknown) => void;
	/** The config's `unsetEnv`, kept from every app and prebuild. */
	unsetEnv?: readonly string[];
	skipContainers?: boolean;
	signal?: AbortSignal;
	shutdownGraceMs?: number;
	runtime?: ContainerRuntimeAdapter;
	/** All selected app waves have completed readiness. */
	onReady?: (signal?: AbortSignal) => void | Promise<void>;
	/** Runs after one app passes readiness (and on restarts), before downstream waves proceed. */
	onAppReady?: (name: string, signal?: AbortSignal) => void | Promise<void>;
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
		apps: Record<string, ResolvedApp>,
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
	/**
	 * A port-owner snapshot taken immediately before spawning wave 1 (by
	 * `classifyCliApps`, when nothing was stopped or prompted since). Consumed
	 * once by the first layer; later layers and wave 2 read fresh.
	 */
	initialPortOwners?: PortOwnerSnapshot;
	/** Work run once named prerequisite apps are ready (e.g. `seed.afterApps`). */
	afterAppsTask?: AfterAppsTask;
	/**
	 * Told each app's spawn env (secrets beneath the computed env) as it is
	 * built, on the first spawn and every restart: the egress guard learns
	 * `allowHostsOf` hosts here.
	 */
	onAppEnv?: (name: string, env: Readonly<Record<string, string>>) => void;
	/** Reactive finite tasks (`onAppReady` / `watch`) supervised beside the apps. Pass `false` to disable. */
	reactiveTasks?: ReactiveTasksInput | false;
	/**
	 * Called after startup waves settle and before `onReady`, giving callers
	 * the session's controls: restart/announce hooks for external watchers
	 * (such as cross-repo links), and starting apps the run left out.
	 */
	onReadyWatch?: (controls: SessionControls, signal: AbortSignal) => void;
}

/** What a caller may ask of a session once its startup waves have settled. */
export interface SessionControls {
	restart(name: string, reason?: string): Promise<boolean>;
	announce(target: string, text: string): void;
	ownedApps(): readonly string[];
	/**
	 * Start apps this run left out at startup, as `essential: false` ones: the
	 * run went on without them, so their going down never ends it. Each layer
	 * of `startAfter` is ready before the next spawns. Resolves with the apps
	 * it took on once they are supervised, before they spawn; throws, taking
	 * on none, when their secrets cannot be loaded or the run is ending.
	 */
	start(apps: Record<string, ResolvedApp>): Promise<readonly string[]>;
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
				: await getPortOwnerAsync(port, { runtime, skipContainers });
			if (holder) {
				const held = formatPortOwner(port, holder, { runtime: runtime?.name });
				const stopIt =
					holder.kind === "process"
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
	apps: Record<string, ResolvedApp>,
	productionBuild: boolean,
): Record<string, ResolvedApp> {
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
	apps: Record<string, ResolvedApp>,
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
		const missingLines = Object.entries(missing)
			.map(([name, keys]) => `  ${name}: ${keys.join(", ")}`)
			.join("\n");
		const message = `Required secrets are missing:\n${missingLines}\nAdd them to the app's Infisical scope, or export them. \`buncargo secrets ls\` shows what each app gets.`;
		throw new Error(message);
	}

	return secrets;
}

/** How an app shows it is ready: alive is no check at all. */
function readinessCheck(config: ResolvedApp): "output" | "health" | "none" {
	return typedSwitch(config.readiness.kind, {
		output: () => "output" as const,
		http: () => "health" as const,
		alive: () => "none" as const,
		none: () => "none" as const,
	});
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
 * Overlap task triggered as soon as every prerequisite app in `waitingOn`
 * reports ready, while remaining apps keep starting in parallel.
 */
function createDeferredTask(
	waitingOn: readonly string[],
	run: (signal: AbortSignal) => Promise<void>,
	supervisor: AppSupervision,
) {
	const pending = new Set(waitingOn);
	const controller = new AbortController();
	const taskSignal = anySignal(supervisor.signal, controller.signal);
	let settled = false;
	let started = false;
	const completion = Promise.withResolvers<void>();
	void completion.promise.catch(() => {});

	const start = () => {
		if (started) return;
		started = true;
		Promise.resolve()
			.then(() => run(taskSignal))
			.then(
				() => completion.resolve(),
				(error) => {
					supervisor.controller.abort(error);
					completion.reject(error);
				},
			)
			.finally(() => {
				settled = true;
			});
	};

	return {
		startIfReady() {
			if (pending.size === 0) start();
		},
		onAppReady(name: string) {
			if (pending.delete(name) && pending.size === 0) start();
		},
		async wait() {
			if (!started && pending.size > 0) {
				throw new Error(
					`Prerequisite app(s) did not become ready: ${[...pending].join(", ")}`,
				);
			}
			if (!started) start();
			await supervisor.race(completion.promise);
		},
		cancel(error?: unknown) {
			if (!settled) controller.abort(error);
		},
		async settled() {
			if (started) await Promise.allSettled([completion.promise]);
		},
	};
}

/**
 * Start configured dev servers, holding `needsPublicUrls` apps for a second
 * wave when tunnels are opening (see `deferPublicUrlApps`).
 */
export async function startDevServers(
	apps: Record<string, ResolvedApp>,
	root: string,
	envVarsByApp:
		| Record<string, Record<string, string>>
		| ((name: string) => Record<string, string>),
	ports: Record<string, number>,
	options: StartDevServersOptions = {},
): Promise<Record<string, number>> {
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
		afterAppsTask,
	} = options;

	const startable = startableApps(apps, productionBuild);

	// Here rather than in the environment layer because this is the one function
	// every spawner goes through: the environment's `spawn()`, which `start()`
	// and the CLI both use, lands here, and another caller cannot miss it.
	// Lowest precedence: the app's computed env is layered on top, and
	// `loadAppSecrets` drops keys the developer already exported.
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

	const appEnv = (name: string) => {
		const env = { ...secrets[name], ...resolveAppEnv(envVarsByApp, name) };
		options.onAppEnv?.(name, env);
		return env;
	};

	const order = planSpawnOrder(
		startable,
		deferPublicUrlApps,
		afterAppsTask?.beforeOtherApps ? afterAppsTask.apps : undefined,
	);
	const reactiveTasksInput = options.reactiveTasks || undefined;
	const nameWidth = prefixWidth([
		...Object.keys(startable),
		...Object.keys(reactiveTasksInput?.tasks ?? {}),
	]);
	const output = options.output ?? new RunOutput({ terminals: "pipe" });
	const stopPrinting = options.output
		? undefined
		: printStream(output, { width: nameWidth });
	const closeOwnOutput = async () => {
		if (options.output) return;
		await output.close();
		output.dispose();
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
	let overlapTask: ReturnType<typeof createDeferredTask> | undefined;
	let reactiveTasks: ReactiveTaskRunner | undefined;

	const supervised = (config: ResolvedApp, name: string): SupervisedApp => ({
		optional: !config.essential,
		worker: config.port === undefined,
		checked: readinessCheck(config) !== "none",
		attached: name === attachedName,
		port: config.port === undefined ? undefined : ports[name],
		graceMs: config.stopGraceMs,
		startAfter: config.startAfter,
	});

	const supervisor = new AppSupervision(mapValues(startable, supervised), {
		signal: anySignal(options.signal, interrupts.signal),
		shutdownGraceMs: options.shutdownGraceMs,
		keepOthersOnFailure: options.keepOthersOnFailure,
		requiredBy: afterAppsTask
			? [{ label: afterAppsTask.label, apps: afterAppsTask.apps }]
			: undefined,
		onPhase: (name, life, previous, event) => {
			if (life.phase === "ready" && previous.phase !== "ready") {
				overlapTask?.onAppReady(name);
			}
			reactiveTasks?.onAppPhase(name, life.phase, previous.phase);
			showPhase(name, life, previous, event);
			return options.onAppPhase?.(name, life, previous);
		},
		onNotice: (name, text) =>
			output.announce(name, text, { raw: formatWarn(text), level: "warn" }),
	});

	if (reactiveTasksInput && Object.keys(reactiveTasksInput.tasks).length > 0) {
		reactiveTasks = new ReactiveTaskRunner({
			root,
			apps: reactiveTasksInput.apps ?? apps,
			tasks: reactiveTasksInput.tasks,
			buildEnv: reactiveTasksInput.buildEnv,
			output,
			signal: supervisor.signal,
			watch: options.watch,
			initialReadyApps: reactiveTasksInput.initialReadyApps,
			unsetEnv: options.unsetEnv,
			shutdownGraceMs: options.shutdownGraceMs,
		});
	}

	if (afterAppsTask && !afterAppsTask.beforeOtherApps) {
		overlapTask = createDeferredTask(
			afterAppsTask.apps.filter((name) => name in startable),
			afterAppsTask.run,
			supervisor,
		);
	}

	const pids = supervisor.pids;
	let handedOff = false;

	/** The rows: stream mode, the TUI and the log files, through `output`. */
	function showPhase(
		name: string,
		life: AppLife,
		previous: AppLife,
		event: AppEvent,
	): void {
		if (verbose && life.pid !== undefined && life.pid !== previous.pid) {
			output.announce(name, `PID: ${life.pid}`, {
				raw: formatPidLine(name, life.pid, nameWidth),
			});
		}

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

	const firstSpawns = new Map<string, Promise<boolean>>();
	// A replaced app is ready again the way it was the first time: checked
	// on the side, so a failing restart never stalls the others.
	const restartApp = async (name: string, reason?: string) => {
		// Never spawned (a later layer whose prerequisite did not come up, or
		// its port was held): a restart is its first spawn, one at a time.
		const spawning = firstSpawns.get(name);
		if (spawning) return spawning;

		const life = supervisor.has(name) ? supervisor.life(name) : undefined;
		const config = startable[name];
		if (life?.generation === 0 && life.phase === "down" && config) {
			const first = spawnLate({ [name]: config })
				.then(() => supervisor.life(name).generation > 0)
				.finally(() => firstSpawns.delete(name));
			firstSpawns.set(name, first);
			return first;
		}

		const replaced = await supervisor.restart(name, reason);
		if (replaced) checkOnTheSide(name, true);

		return replaced;
	};

	output.controls = {
		restart: (name) => {
			if (reactiveTasks?.has(name)) {
				return Promise.resolve(reactiveTasks.trigger(name, "requested"));
			}
			return restartApp(name, "requested");
		},
	};

	const scannerFor = createCaptureRestarts(startable, {
		signal: supervisor.signal,
		onCapture: (app, captured) => {
			output.capture(app, captured);
			return onCapture?.(app, captured) ?? [];
		},
		restart: async (name) => {
			await restartApp(name);
		},
	});

	/** Spared if it goes down now: `essential: false`, on probation, or parked. */
	const spared = (name: string) =>
		supervisor.life(name).standing !== "essential";
	let pendingWave1Owners = options.initialPortOwners;

	async function spawnWave(
		wave: Record<string, ResolvedApp>,
		probation: (name: string) => boolean,
	): Promise<void> {
		// Per wave, not per run: a later wave spawns after tunnels have opened
		// and earlier servers have bound their ports, so a snapshot taken before
		// the first wave would be describing a machine that has since changed.
		supervisor.signal.throwIfAborted();

		const suppliedOwners = pendingWave1Owners;
		pendingWave1Owners = undefined;
		const portOwners =
			suppliedOwners ??
			(await createPortOwnerSnapshotAsync({
				signal: supervisor.signal,
				runtime: options.runtime,
				skipContainers: options.skipContainers,
				ports: Object.keys(wave).flatMap((name) => {
					const port = ports[name];
					return port === undefined ? [] : [port];
				}),
			}));

		const toStart: [string, ResolvedApp][] = [];
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
						unsetEnv: options.unsetEnv,
					}),
				),
			),
		);

		for (const [name, config] of toStart) {
			const attached = name === attachedName;
			const onText = scannerFor(name, config);

			const spawnOnce = () =>
				spawnManagedApp(name, config, root, appEnv(name), {
					attached,
					extraArgs: attached ? extraArgs : [],
					productionBuild,
					waitForExit,
					output,
					onText: watchForReady(name, config, onText),
					unsetEnv: options.unsetEnv,
				});

			const spawnApp = (onProbation = false) =>
				config.port === undefined
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
		config: ResolvedApp,
		onText: ((text: string) => void) | undefined,
	): ((text: string) => void) | undefined {
		const { readiness } = config;
		if (readiness.kind !== "output") return onText;

		const printed = Promise.withResolvers<void>();
		printedReady.set(name, printed.promise);

		const scanner = createOutputCaptureScanner({
			ready: { pattern: readiness.pattern, as: "event" },
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
		config: ResolvedApp,
		signal: AbortSignal,
	): Promise<void> {
		const printed = printedReady.get(name);
		if (!printed) return;

		const timeoutMs = config.healthTimeout;
		const done = new AbortController();
		const seconds = Math.round(timeoutMs / 1000);
		const pattern =
			config.readiness.kind === "output" ? config.readiness.pattern : "";
		const timedOut = `${name} did not print ${pattern} within ${seconds}s`;

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
			await options.onAppReady?.(name, signal);
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
		app: Record<string, ResolvedApp>,
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
					config?.port !== undefined && config.readiness.kind !== "none";
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

	/**
	 * An app's `watch` watcher. Only for an app this run spawned: a reused
	 * one has nothing here to restart.
	 */
	function watchFiles(name: string): void {
		const config = startable[name];
		if (options.watch === false || !config?.watch) return;
		if (pids[name] === undefined) return;

		watchApp({
			name,
			dir: config.cwd ? resolve(root, config.cwd) : root,
			config: config.watch,
			signal: supervisor.signal,
			onChange: (reason) => {
				void restartApp(name, reason).catch(() => {});
			},
		});
	}

	/** {@link watchFiles} for an app started late: a watcher it cannot have is said, not fatal. */
	function watchLateFiles(name: string): void {
		try {
			watchFiles(name);
		} catch (error) {
			const text = `Not watching ${name}'s files: ${toError(error).message}`;
			output.announce(name, text, { raw: formatWarn(text), level: "warn" });
		}
	}

	/** See {@link SessionControls.start}. */
	async function startLate(
		apps: Record<string, ResolvedApp>,
	): Promise<readonly string[]> {
		supervisor.signal.throwIfAborted();
		const fresh = Object.fromEntries(
			Object.entries(startableApps(apps, productionBuild)).filter(
				([name]) => !supervisor.has(name),
			),
		);
		if (Object.keys(fresh).length === 0) return [];

		const loaded = await loadStartSecrets(
			fresh,
			(name) => resolveAppEnv(envVarsByApp, name),
			{ signal: supervisor.signal },
		);
		supervisor.signal.throwIfAborted();

		// Another start may have taken one on while the secrets loaded.
		const names: string[] = [];
		for (const [name, config] of Object.entries(fresh)) {
			if (supervisor.has(name)) continue;
			names.push(name);
			secrets[name] = loaded[name] ?? {};
			startable[name] = config;
			supervisor.add(name, { ...supervised(config, name), optional: true });
			// Its row says so before it spawns, which may wait on a layer.
			output.state(name, { state: "starting" });
		}

		// The run went on without them: whatever goes wrong fails them, not it.
		void spawnLate(pick(fresh, names)).catch(async (error) => {
			if (supervisor.signal.aborted) return;
			const pending = names.filter(
				(name) => supervisor.life(name).phase !== "down",
			);
			await supervisor.fail(pending.map((name) => toAppFailure(name, error)));
		});
		return names;
	}

	/**
	 * Spawn apps taken on after startup, a `startAfter` layer at a time. One
	 * that does not come up is parked like any spared app, and what was still
	 * to spawn after it is failed, naming it.
	 */
	async function spawnLate(apps: Record<string, ResolvedApp>): Promise<void> {
		const order = planSpawnOrder(apps, false);
		const layers = [
			...order.beforeBarrier,
			...order.beforeTunnels,
			...order.afterTunnels,
		]
			.map((layer) => Object.keys(layer))
			.filter((names): names is [string, ...string[]] => names.length > 0);

		const notStarted = (names: readonly string[], cause: string) =>
			names.map(
				(name) =>
					new AppFailure(
						name,
						"start",
						`${name} did not start: ${cause} did not come up`,
					),
			);
		const later = (index: number) => layers.slice(index + 1).flat();

		for (const [index, names] of layers.entries()) {
			try {
				await spawnWave(pick(apps, names), () => false);
			} catch (error) {
				if (supervisor.signal.aborted) return;

				const failure = toAppFailure(names[0], error);
				const unspawned = names.filter(
					(name) =>
						name !== failure.app && supervisor.life(name).generation === 0,
				);
				await supervisor.fail([
					failure,
					...notStarted([...unspawned, ...later(index)], failure.app),
				]);
				return;
			}

			for (const name of names) watchLateFiles(name);

			if (index === layers.length - 1) {
				for (const name of names) checkOnTheSide(name, true);
				return;
			}

			const drift = watchDrift(names);
			try {
				const results = await supervisor.race(
					Promise.allSettled(names.map(appReady)),
				);
				const failures = names.flatMap((name, at) => {
					const result = results[at];
					return result?.status === "rejected"
						? [toAppFailure(name, result.reason)]
						: [];
				});
				if (failures.length > 0) {
					const cause = failures.map((failure) => failure.app).join(", ");
					await supervisor.fail([
						...failures,
						...notStarted(later(index), cause),
					]);
					return;
				}
			} finally {
				drift.abort();
			}
		}
	}

	async function startWave(wave: Record<string, ResolvedApp>): Promise<void> {
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
			for (const name of names) {
				if (!essential.includes(name)) checkOnTheSide(name, false);
			}

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
		overlapTask?.startIfReady();

		// Prerequisite apps for a blocking `afterAppsTask` (e.g. `seed.afterApps`)
		// come up first, then the barrier task runs before the remaining apps spawn.
		for (const layer of order.beforeBarrier) await startWave(layer);
		if (afterAppsTask?.beforeOtherApps) {
			await supervisor.race(afterAppsTask.run(supervisor.signal));
		}

		// Each layer is ready before the next spawns: that is `startAfter`.
		for (const layer of order.beforeTunnels) await startWave(layer);

		if (onAfterWave1) {
			await supervisor.race(onAfterWave1(supervisor.signal));
		}

		for (const layer of order.afterTunnels) await startWave(layer);

		supervisor.signal.throwIfAborted();

		if (overlapTask) {
			await overlapTask.wait();
		}

		// After startup, so a save mid-start cannot race the first health check.
		for (const name of Object.keys(startable)) watchFiles(name);

		// Arm reactive task file watchers (unless --no-watch) and any tasks
		// whose prerequisite apps were already healthy via reuse.
		reactiveTasks?.arm();

		// Armed before `onReady` so external watchers (such as cross-repo links
		// started by `--with-links`) never miss a fast companion transition.
		options.onReadyWatch?.(
			{
				restart: restartApp,
				announce: (target, text) =>
					output.announce(target, text, { raw: formatStep(text) }),
				ownedApps: () =>
					Object.keys(startable).filter((name) => pids[name] !== undefined),
				start: startLate,
			},
			supervisor.signal,
		);

		if (options.onReady) {
			await supervisor.race(
				Promise.resolve().then(() => options.onReady?.(supervisor.signal)),
			);
		}

		if (waitForExit) {
			await supervisor.wait();
			try {
				await supervisor.stop();
			} finally {
				await reactiveTasks?.stop();
			}
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
						await reactiveTasks?.stop();
						interrupts.dispose();
						await closeOwnOutput();
					}
				}
			})().catch((error) => console.error(error));
			supervisor.closeWith(closing);
		}

		return pids;
	} catch (error) {
		overlapTask?.cancel(error);
		await overlapTask?.settled();
		try {
			try {
				await supervisor.stop();
			} finally {
				await reactiveTasks?.stop();
			}
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
