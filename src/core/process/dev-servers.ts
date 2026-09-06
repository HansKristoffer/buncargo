import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ContainerRuntimeAdapter } from "../../container-runtime/types";
import type { AppConfig, DevServerPids } from "../../types";
import { waitForDevServers } from "../network";
import { recordStartupMetric } from "../startup-metrics";
import {
	formatPidLine,
	formatPrefixedLine,
	formatSection,
	formatStep,
	formatWarn,
	isBlankLogLine,
	prefixWidth,
} from "../style";
import {
	classifyPortOccupant,
	createPortOwnerSnapshot,
	formatPortOwner,
	getPortOwner,
	killPortOwner,
	type PortOwnerSnapshot,
} from "./port-owner";
import { ProcessOwner, RunInterrupted } from "./process-owner";

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
		env: { ...process.env, ...envVars },
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
	 * A dev server exited. `code` is `null` when it was signalled, which is what
	 * a `buncargo stop <app>` or a Ctrl-C looks like from here.
	 */
	onAppExit?: (
		name: string,
		code: number | null,
		signal?: NodeJS.Signals | null,
	) => void;
}

function resolveShell(): string {
	for (const candidate of [
		process.env.SHELL,
		"/bin/zsh",
		"/bin/bash",
		"/bin/sh",
	]) {
		if (candidate && existsSync(candidate)) {
			return candidate;
		}
	}
	return "/bin/sh";
}

const SHELL = resolveShell();

function prefixStream(
	name: string,
	stream: NodeJS.ReadableStream | null,
	options: { width: number; onFirstWrite: () => void },
): void {
	if (!stream) return;
	let buffer = "";
	const writeLine = (line: string) => {
		if (isBlankLogLine(line)) return;
		options.onFirstWrite();
		process.stdout.write(formatPrefixedLine(name, line, options.width));
	};
	stream.on("data", (chunk: Buffer | string) => {
		buffer += String(chunk);
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			writeLine(line);
		}
	});
	stream.on("end", () => {
		if (buffer) writeLine(buffer);
	});
}

function pickWave(
	apps: Record<string, AppConfig>,
	needsPublicUrls: boolean,
	defer: boolean,
): Record<string, AppConfig> {
	return Object.fromEntries(
		Object.entries(apps).filter(([, app]) => {
			// Without deferral there is no wave 2, so wave 1 is everything.
			const wave = defer ? Boolean(app.needsPublicUrls) : false;
			return wave === needsPublicUrls;
		}),
	);
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

function resolveStartCommand(
	config: AppConfig,
	productionBuild: boolean,
): string | undefined {
	const command = productionBuild
		? (config.prodCommand ??
			(typeof config.devCommand === "string" ? config.devCommand : undefined))
		: config.devCommand;
	return typeof command === "string" ? command : undefined;
}

function spawnManagedApp(
	name: string,
	config: AppConfig,
	root: string,
	envVars: Record<string, string>,
	options: {
		attached: boolean;
		extraArgs: string[];
		productionBuild: boolean;
		waitForExit: boolean;
		prefixWidth: number;
		onFirstLog: () => void;
	},
): ChildProcess {
	const baseCommand = resolveStartCommand(config, options.productionBuild);
	if (baseCommand === undefined) {
		throw new Error(`App "${name}" has no startable devCommand`);
	}
	const command =
		options.attached && options.extraArgs.length > 0
			? `${baseCommand} ${options.extraArgs.join(" ")}`
			: baseCommand;
	recordStartupMetric("subprocesses");
	const child = spawn(command, [], {
		cwd: config.cwd ? resolve(root, config.cwd) : root,
		env: { ...process.env, ...envVars },
		stdio: options.attached ? "inherit" : ["ignore", "pipe", "pipe"],
		shell: SHELL,
		detached: true,
	});
	if (!options.attached) {
		const streamOptions = {
			width: options.prefixWidth,
			onFirstWrite: options.onFirstLog,
		};
		prefixStream(name, child.stdout, streamOptions);
		prefixStream(name, child.stderr, streamOptions);
	}
	if (!options.waitForExit && child.unref) {
		child.unref();
	}
	return child;
}

async function prepareAppPort(
	name: string,
	port: number | undefined,
	root: string,
	projectName: string,
	verbose: boolean,
	ports: PortOwnerSnapshot,
	runtime?: ContainerRuntimeAdapter,
): Promise<"reuse" | "start"> {
	if (port === undefined) return "start";
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
		await killPortOwner(port, { verbose, runtime });
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
	} = options;

	const startable = Object.fromEntries(
		Object.entries(apps).filter(
			([, app]) => resolveStartCommand(app, productionBuild) !== undefined,
		),
	);
	const wave1 = pickWave(startable, false, deferPublicUrlApps);
	const wave2 = pickWave(startable, true, deferPublicUrlApps);
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
	const nameWidth = prefixWidth(Object.keys(startable));
	let logsHeaderPrinted = false;
	const onFirstLog = () => {
		if (logsHeaderPrinted) return;
		logsHeaderPrinted = true;
		process.stdout.write(`\n${formatSection("Logs")}\n`);
	};

	async function spawnWave(wave: Record<string, AppConfig>): Promise<void> {
		// Per wave, not per run: wave 2 spawns after tunnels have opened and
		// wave-1 servers have bound their ports, so a snapshot taken before
		// wave 1 would be describing a machine that has since changed.
		owner.controller.signal.throwIfAborted();
		const portOwners = createPortOwnerSnapshot({
			runtime: options.runtime,
			ports: Object.keys(wave).flatMap((name) => {
				const port = ports[name];
				return port === undefined ? [] : [port];
			}),
		});
		for (const [name, config] of Object.entries(wave)) {
			const prepared = await prepareAppPort(
				name,
				ports[name],
				root,
				projectName,
				verbose,
				portOwners,
				options.runtime,
			);
			owner.controller.signal.throwIfAborted();
			if (prepared === "reuse") continue;
			const attached = name === attachedName;
			const child = spawnManagedApp(
				name,
				config,
				root,
				resolveAppEnv(envVarsByApp, name),
				{
					attached,
					extraArgs: attached ? extraArgs : [],
					productionBuild,
					waitForExit,
					prefixWidth: nameWidth,
					onFirstLog,
				},
			);
			owner.register(name, child, config.healthEndpoint !== false);
			if (child.pid) {
				pids[name] = child.pid;
				onAppSpawned?.(name, child.pid, attached);
				if (verbose) {
					console.log(formatPidLine(name, child.pid, nameWidth));
				}
			}
		}
	}

	async function startWave(wave: Record<string, AppConfig>): Promise<void> {
		if (Object.keys(wave).length === 0) return;
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
		await startWave(wave1);
		if (onAfterWave1) await owner.race(onAfterWave1(owner.controller.signal));
		await startWave(wave2);
		owner.controller.signal.throwIfAborted();
		if (options.onReady)
			await owner.race(
				Promise.resolve().then(() =>
					options.onReady?.(owner.controller.signal),
				),
			);
		if (waitForExit) {
			await owner.wait();
			await owner.stop();
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
		owner.dispose();
	}
}
