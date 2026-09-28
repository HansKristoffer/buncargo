import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { resolve } from "node:path";
import type { ContainerRuntimeAdapter } from "../../container-runtime/types";
import type { AppConfig, DevServerPids } from "../../types";
import { waitForDevServers } from "../network";
import { connectProcessEnv } from "../runtime-flags";
import { loadAppSecrets, missingRequiredSecrets } from "../secrets/infisical";
import { recordStartupMetric } from "../startup-metrics";
import {
	formatPidLine,
	formatSection,
	formatStep,
	formatWarn,
	prefixWidth,
} from "../style";
import {
	ptyTeeArgv,
	resolveStartCommand,
	runPrebuild,
	spawnManagedApp,
} from "./app-process";
import {
	type CapturedValue,
	createOutputCaptureScanner,
} from "./output-capture";
import {
	classifyPortOccupant,
	createPortOwnerSnapshot,
	formatPortOwner,
	getPortOwner,
	killPortOwner,
	type PortOwnerSnapshot,
} from "./port-owner";
import { ProcessOwner, RunInterrupted } from "./process-owner";
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

	const parts = command.split(" ");
	const cmd = parts[0];
	const args = parts.slice(1);

	if (!cmd) {
		throw new Error("Command cannot be empty");
	}

	const spawnOptions: SpawnOptions = {
		cwd: appCwd ? resolve(root, appCwd) : root,
		env: connectProcessEnv({ ...process.env, ...envVars }),
		detached,
		stdio: isCI || verbose ? "inherit" : "ignore",
	};

	recordStartupMetric("subprocesses");
	const proc = spawn(cmd, args, spawnOptions);

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
	/** App that owns the TTY. Others get prefixed pipes. */
	attach?: string;
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
const activeOwners = new Map<number, ProcessOwner>();

export async function stopDevServers(pids: DevServerPids): Promise<void> {
	await Promise.all(
		[
			...new Set(
				Object.values(pids).flatMap((pid) => activeOwners.get(pid) ?? []),
			),
		].map((owner) => owner.stop()),
	);
}

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
	const configuredInteractive = Object.entries(startable).find(
		([, app]) => app.interactive,
	)?.[0];
	const attachedName = attachOverride ?? configuredInteractive;
	if (attachOverride && !startable[attachOverride]) {
		throw new Error(`--attach=${attachOverride} is not in the start set`);
	}

	const owner = new ProcessOwner({
		signal: options.signal,
		shutdownGraceMs: options.shutdownGraceMs,
		attachedName,
		onAppExit,
	});
	const pids: DevServerPids = {};
	let handedOff = false;
	const dispose = () => {
		for (const pid of Object.values(pids)) {
			activeOwners.delete(pid);
		}
		owner.dispose();
	};
	const nameWidth = prefixWidth(Object.keys(startable));
	let logsHeaderPrinted = false;
	const onFirstLog = () => {
		if (logsHeaderPrinted) {
			return;
		}
		logsHeaderPrinted = true;
		process.stdout.write(`\n${formatSection("Logs")}\n`);
	};

	// The live child per app, for `restartOn`.
	const children = new Map<string, ChildProcess>();
	const spawners = new Map<string, () => Promise<ChildProcess>>();

	function recordChild(name: string, child: ChildProcess, attached: boolean) {
		children.set(name, child);
		if (!child.pid) return;
		pids[name] = child.pid;
		activeOwners.set(child.pid, owner);
		onAppSpawned?.(name, child.pid, attached);
		if (verbose) {
			console.log(formatPidLine(name, child.pid, nameWidth));
		}
	}

	/** Replace one app's process, with env built fresh (new public URLs, captures). */
	async function restart(name: string): Promise<void> {
		const current = children.get(name);
		const respawn = spawners.get(name);
		if (!current || !respawn || owner.controller.signal.aborted) return;
		console.log(
			formatStep(`🔁 Restarting ${name}: a value it restarts on changed`),
		);
		await owner.retire(current);
		if (current.pid) activeOwners.delete(current.pid);
		const child = await respawn();
		owner.register(name, child, false, startable[name]?.kind === "worker");
		recordChild(name, child, name === attachedName);
	}

	// Captures are handled one at a time, in arrival order: a URL and the
	// restart it triggers must not interleave with the next URL.
	let captureQueue = Promise.resolve();
	function scannerFor(name: string, config: AppConfig) {
		if (!config.captures || Object.keys(config.captures).length === 0) {
			return undefined;
		}
		const scanner = createOutputCaptureScanner(config.captures);
		return (text: string) => {
			for (const captured of scanner.push(text)) {
				captureQueue = captureQueue
					.then(async () => {
						const changed = (await onCapture?.(name, captured)) ?? [];
						const dependents = Object.entries(startable)
							.filter(
								([other, app]) =>
									other !== name &&
									app.restartOn?.some((key) => changed.includes(key)),
							)
							.map(([other]) => other);
						for (const dependent of dependents) await restart(dependent);
					})
					.catch((error: unknown) => {
						console.warn(
							formatWarn(
								`Handling ${name}'s ${captured.name} failed: ${error instanceof Error ? error.message : String(error)}`,
							),
						);
					});
			}
		};
	}

	async function spawnWave(wave: Record<string, AppConfig>): Promise<void> {
		// Per wave, not per run: a later wave spawns after tunnels have opened
		// and earlier servers have bound their ports, so a snapshot taken before
		// the first wave would be describing a machine that has since changed.
		owner.controller.signal.throwIfAborted();
		const portOwners = createPortOwnerSnapshot({
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
						width: nameWidth,
						onFirstLog,
					}),
				),
			),
		);

		for (const [name, config] of toStart) {
			const attached = name === attachedName;
			const onText = scannerFor(name, config);
			if (attached && onText && process.stdin.isTTY && !ptyTeeArgv("")) {
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
					prefixWidth: nameWidth,
					onFirstLog,
					onText,
				});
			const spawnApp = () =>
				config.kind === "worker"
					? spawnOwnedWorker(root, name, spawnOnce, owner.controller.signal)
					: Promise.resolve(spawnOnce());
			spawners.set(name, spawnApp);
			const child = await spawnApp();
			owner.register(
				name,
				child,
				config.kind !== "worker" && config.healthEndpoint !== false,
				config.kind === "worker",
			);
			recordChild(name, child, attached);
		}
	}

	async function startWave(wave: Record<string, AppConfig>): Promise<void> {
		if (Object.keys(wave).length === 0) {
			return;
		}

		await owner.race(spawnWave(wave));
		if (waitForHealth) {
			await owner.race(waitForHealth(wave, owner.controller.signal));
			for (const name of Object.keys(wave)) {
				owner.ready(name);
				options.onAppReady?.(name);
			}
		} else {
			await owner.race(
				waitForDevServers(wave, ports, {
					verbose,
					productionBuild,
					signal: owner.controller.signal,
					onAppReady: (name) => {
						owner.ready(name);
						options.onAppReady?.(name);
					},
				}),
			);
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
		if (options.onReady) {
			await owner.race(
				Promise.resolve().then(() =>
					options.onReady?.(owner.controller.signal),
				),
			);
		}

		if (waitForExit) {
			await owner.wait();
			await owner.stop();
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
						await owner.stop();
					} finally {
						dispose();
					}
				}
			})().catch((error) => console.error(error));
		}

		return pids;
	} catch (error) {
		try {
			await owner.stop();
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
			dispose();
		}
	}
}
