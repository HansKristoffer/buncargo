import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedApp } from "../../types";
import { childProcessEnv } from "../child-env";
import { registerAbortCleanup } from "../deadline";
import { shellQuote } from "../shell-quote";
import { recordStartupMetric } from "../startup-metrics";
import { createLineSplitter } from "./line-splitter";
import { type AppChild, PtyApp } from "./pty-app";
import { defaultScreenSize, type RunOutput } from "./run-output";
import { terminateOwnedProcess } from "./terminate";

/**
 * Spawning one app process: the shell it runs under, where its output goes
 * (a pseudo-terminal of its own in the TUI and for the attached app, pipes
 * otherwise), and its prebuild.
 * `dev-servers.ts` orchestrates many of these.
 */

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

/** Execute configured shell syntax consistently across every app spawn path. */
export function spawnAppCommand(
	command: string,
	options: SpawnOptions,
): ChildProcess {
	if (!command.trim()) throw new Error("Command cannot be empty");
	recordStartupMetric("subprocesses");
	return spawn(command, [], { ...options, shell: SHELL });
}

/** Where and with what env an app's commands run, in their own process group. */
function appSpawnOptions(
	config: ResolvedApp,
	root: string,
	envVars: Record<string, string>,
	unsetEnv: readonly string[] | undefined,
) {
	return {
		cwd: config.cwd ? resolve(root, config.cwd) : root,
		env: childProcessEnv({ ...process.env, ...envVars }, unsetEnv),
		detached: true,
	};
}

export function resolveStartCommand(
	config: ResolvedApp,
	productionBuild: boolean,
): string | undefined {
	const command = productionBuild
		? (config.prodCommand ??
			(typeof config.devCommand === "string" ? config.devCommand : undefined))
		: config.devCommand;
	return typeof command === "string" ? command : undefined;
}

export function spawnManagedApp(
	name: string,
	config: ResolvedApp,
	root: string,
	envVars: Record<string, string>,
	options: {
		attached: boolean;
		extraArgs: string[];
		productionBuild: boolean;
		waitForExit: boolean;
		output: RunOutput;
		/** Raw output, for `captures`. */
		onText?: (text: string) => void;
		/** The config's `unsetEnv`. */
		unsetEnv?: readonly string[];
	},
): AppChild {
	const baseCommand = resolveStartCommand(config, options.productionBuild);
	if (baseCommand === undefined) {
		throw new Error(`App "${name}" has no startable devCommand`);
	}

	const command =
		options.attached && options.extraArgs.length > 0
			? `${baseCommand} ${options.extraArgs.map(shellQuote).join(" ")}`
			: baseCommand;
	const base = appSpawnOptions(config, root, envVars, options.unsetEnv);
	const { output } = options;

	// The TUI: every app gets a terminal of its own, sized to its pane, and
	// keeps its screen (and scrollback) across restarts. The same for an
	// interactive app with no terminal to attach to (an agent's shell, a
	// detached run): Expo refuses to start its dev server without one, and
	// agents piped `tail -f /dev/null | script …` into it to fake it. Its keys
	// then come from `buncargo send`.
	if (
		output.terminals === "pty" ||
		(options.attached && !process.stdin.isTTY)
	) {
		const screen = output.screen(name);
		const decoder = new TextDecoder();
		const child = new PtyApp([SHELL, "-c", command], {
			cwd: base.cwd,
			env: base.env,
			cols: screen.term.cols,
			rows: screen.term.rows,
			onData: (data) => {
				screen.write(data);
				options.onText?.(decoder.decode(data, { stream: true }));
			},
		});
		screen.bind(child);
		if (!options.waitForExit) child.unref();
		return child;
	}

	if (options.attached) return attachToTerminal(name, command, base, options);

	const child = spawnAppCommand(command, {
		...base,
		stdio: ["ignore", "pipe", "pipe"],
	});
	output.pipe(name, child.stdout, options.onText);
	output.pipe(name, child.stderr, options.onText);
	if (!options.waitForExit) child.unref();
	return child;
}

/**
 * Stream mode's attached app, on a real terminal: a pseudo-terminal of its
 * own whose output passes through to ours unchanged, with our keys and size
 * passed to it, so TUIs like Shopify CLI see a TTY. Its lines feed the log and
 * captures, marked as already on the terminal. It leads its own session, so
 * stopping its process group reaches all it spawned (under `script` it reached
 * only `script`).
 */
function attachToTerminal(
	name: string,
	command: string,
	base: ReturnType<typeof appSpawnOptions>,
	options: Parameters<typeof spawnManagedApp>[4],
) {
	const { stdin, stdout } = process;
	const lines = createLineSplitter({
		onText: options.onText,
		onLine: (line) => options.output.line(name, line, { echoed: true }),
	});
	const child = new PtyApp([SHELL, "-c", command], {
		cwd: base.cwd,
		env: base.env,
		...terminalSize(),
		onData: (data) => {
			stdout.write(data);
			lines.push(data);
		},
	});

	// Raw, like the app's own terminal: Ctrl-C reaches the app as a key, and
	// its exit ends the run.
	const forwardKeys = (data: Uint8Array) => child.write(data);
	const forwardSize = () => {
		const { cols, rows } = terminalSize();
		child.resize(cols, rows);
	};
	const restoreTerminal = () => stdin.setRawMode?.(false);
	stdin.setRawMode?.(true);
	stdin.on("data", forwardKeys);
	stdin.resume();
	stdout.on("resize", forwardSize);
	process.once("exit", restoreTerminal);
	child.once("exit", () => {
		lines.end();
		stdin.off("data", forwardKeys);
		stdin.pause();
		restoreTerminal();
		process.off("exit", restoreTerminal);
		stdout.off("resize", forwardSize);
	});

	if (!options.waitForExit) child.unref();
	return child;
}

/** Our terminal's size, or a default when stdout is piped. */
function terminalSize() {
	const { columns, rows } = process.stdout;
	return columns && rows ? { cols: columns, rows } : defaultScreenSize();
}

/**
 * Run an app's `prebuild` to completion, its output prefixed like the app's.
 * Cancelled with the run: a Ctrl-C during a slow build must not leave it
 * running behind the terminal.
 */
export async function runPrebuild(
	name: string,
	config: ResolvedApp,
	root: string,
	envVars: Record<string, string>,
	options: {
		signal: AbortSignal;
		output: RunOutput;
		graceMs?: number;
		unsetEnv?: readonly string[];
	},
): Promise<void> {
	const command = config.prebuild;
	if (!command) return;
	options.signal.throwIfAborted();
	const child = spawnAppCommand(command, {
		...appSpawnOptions(config, root, envVars, options.unsetEnv),
		stdio: ["ignore", "pipe", "pipe"],
	});
	options.output.pipe(name, child.stdout);
	options.output.pipe(name, child.stderr);

	// Cancelled once the build has exited: whoever awaits the abort waits for it.
	const onAbort = () =>
		registerAbortCleanup(
			options.signal,
			terminateOwnedProcess(child, options.graceMs),
		);
	options.signal.addEventListener("abort", onAbort, { once: true });
	try {
		const code = await new Promise<number | null>((resolvePromise, reject) => {
			child.once("error", reject);
			child.once("exit", (exitCode) => resolvePromise(exitCode));
		});
		options.signal.throwIfAborted();
		if (code !== 0) {
			throw new Error(
				`Prebuild for "${name}" (${command}) exited with code ${code ?? "null"}`,
			);
		}
	} finally {
		options.signal.removeEventListener("abort", onAbort);
	}
}
