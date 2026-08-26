import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig, DevServerPids } from "../../types";
import { waitForDevServers } from "../network";
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
	formatPortOwner,
	getPortOwner,
	killPortOwner,
	signalProcessTree,
} from "./port-owner";

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

	const proc = spawn(cmd, args, spawnOptions);

	if (detached && proc.unref) {
		proc.unref();
	}

	return proc;
}

export interface StartDevServersOptions {
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
	onAfterWave1?: () => Promise<void>;
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
	waitForHealth?: (apps: Record<string, AppConfig>) => Promise<void>;
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

function killChildTree(child: ChildProcess): void {
	if (!child.pid) return;
	try {
		signalProcessTree(child.pid, "SIGTERM");
	} catch {
		try {
			child.kill("SIGTERM");
		} catch {
			// already dead
		}
	}
}

function installSignalHandlers(handler: () => void): () => void {
	process.on("SIGINT", handler);
	process.on("SIGTERM", handler);
	process.on("SIGHUP", handler);
	return () => {
		process.off("SIGINT", handler);
		process.off("SIGTERM", handler);
		process.off("SIGHUP", handler);
	};
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
): Promise<"reuse" | "start"> {
	if (port === undefined) return "start";
	const owner = getPortOwner(port);
	const action = classifyPortOccupant(owner, { root, projectName });
	if (action === "reuse") {
		if (verbose) {
			console.log(
				formatStep(`♻️  Reusing existing process on port ${port} (${name})`),
			);
		}
		return "reuse";
	}
	if (action === "fail" && owner) {
		throw new Error(formatPortOwner(port, owner));
	}
	if (action === "kill") {
		await killPortOwner(port, { verbose });
	}
	return "start";
}

/**
 * Supervise spawned children until they exit, forwarding signals and failing
 * fast when any app dies with a non-zero code. Closing the attached app (the
 * one holding the TTY) tears down the rest.
 */
function superviseChildren(
	children: Array<{ name: string; child: ChildProcess }>,
	options: { attachedName?: string; onSignal?: () => void | Promise<void> },
): Promise<void> {
	const { attachedName, onSignal } = options;

	return new Promise<void>((resolvePromise, rejectPromise) => {
		let settled = false;
		let remaining = children.length;

		const cleanupListeners = installSignalHandlers(() => {
			void (async () => {
				if (onSignal) await onSignal();
				for (const { child } of children) {
					killChildTree(child);
				}
			})();
		});

		const resolveOnce = () => {
			if (settled) return;
			settled = true;
			cleanupListeners();
			resolvePromise();
		};

		const rejectOnce = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanupListeners();
			for (const { child } of children) {
				killChildTree(child);
			}
			rejectPromise(error);
		};

		for (const { name, child } of children) {
			child.on("error", (error) => {
				rejectOnce(
					new Error(`Failed to start app "${name}": ${error.message}`),
				);
			});

			child.on("close", (code) => {
				remaining -= 1;
				if (name === attachedName) {
					for (const other of children) {
						if (other.name !== name) killChildTree(other.child);
					}
					if (code !== 0 && code !== null) {
						rejectOnce(new Error(`App "${name}" exited with code ${code}`));
						return;
					}
					resolveOnce();
					return;
				}
				if (code !== 0 && code !== null) {
					rejectOnce(new Error(`App "${name}" exited with code ${code}`));
					return;
				}
				if (remaining === 0) {
					resolveOnce();
				}
			});
		}
	});
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

	const children: Array<{ name: string; child: ChildProcess }> = [];
	const pids: DevServerPids = {};
	const nameWidth = prefixWidth(Object.keys(startable));
	let logsHeaderPrinted = false;
	const onFirstLog = () => {
		if (logsHeaderPrinted) return;
		logsHeaderPrinted = true;
		process.stdout.write(`\n${formatSection("Logs")}\n`);
	};

	async function spawnWave(wave: Record<string, AppConfig>): Promise<void> {
		for (const [name, config] of Object.entries(wave)) {
			const prepared = await prepareAppPort(
				name,
				ports[name],
				root,
				projectName,
				verbose,
			);
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
			children.push({ name, child });
			if (child.pid) {
				pids[name] = child.pid;
				if (verbose) {
					console.log(formatPidLine(name, child.pid, nameWidth));
				}
			}
		}
	}

	if (Object.keys(wave1).length > 0) {
		await spawnWave(wave1);
		if (waitForHealth) {
			await waitForHealth(wave1);
		} else {
			await waitForDevServers(wave1, ports, { verbose });
		}
	}

	if (onAfterWave1) {
		await onAfterWave1();
	}

	if (Object.keys(wave2).length > 0) {
		await spawnWave(wave2);
	}

	if (!waitForExit || children.length === 0) {
		return pids;
	}

	await superviseChildren(children, { attachedName, onSignal });

	return pids;
}
