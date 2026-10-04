import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "../../types";
import { childProcessEnv } from "../child-env";
import { shellQuote } from "../shell-quote";
import { recordStartupMetric } from "../startup-metrics";
import { type AppChild, PtyApp } from "./pty-app";
import type { RunOutput } from "./run-output";
import { terminateOwnedProcess } from "./terminate";

/**
 * Spawning one app process: the shell it runs under, where its output goes
 * (a pseudo-terminal of its own in the TUI, pipes otherwise), the `script`
 * tee that lets captures read a legacy attached app, and its prebuild.
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
	config: AppConfig,
	root: string,
	envVars: Record<string, string>,
) {
	return {
		cwd: config.cwd ? resolve(root, config.cwd) : root,
		env: childProcessEnv({ ...process.env, ...envVars }),
		detached: true,
	};
}

export function resolveStartCommand(
	config: AppConfig,
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
	config: AppConfig,
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
	const base = appSpawnOptions(config, root, envVars);
	const { output } = options;

	// The TUI: every app gets a terminal of its own, sized to its pane, and
	// keeps its screen (and scrollback) across restarts. The same for an
	// interactive app with no terminal to attach to (an agent's shell, a
	// detached run): Expo refuses to start its dev server without one, and
	// agents piped `tail -f /dev/null | script …` into it to fake it. Its keys
	// then come from `buncargo send`.
	if (output.terminalSize || (options.attached && !process.stdin.isTTY)) {
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

	// The legacy attached app keeps the real terminal (one without a terminal
	// took the pseudo-terminal path above). Capturing from it needs its output
	// too, so it runs under `script`, whose copy of the output passes through
	// here unchanged; TUIs like Shopify CLI see a TTY. Captured also when
	// logging, so the attached app has a log file too.
	const capturing =
		options.attached &&
		(options.onText !== undefined || output.logs !== undefined);
	const tee = capturing ? ptyTeeArgv(command) : null;
	if (tee) recordStartupMetric("subprocesses");
	const child = tee
		? spawn(tee[0], tee.slice(1), {
				...base,
				stdio: ["inherit", "pipe", "inherit"],
			})
		: spawnAppCommand(command, {
				...base,
				stdio: options.attached ? "inherit" : ["ignore", "pipe", "pipe"],
			});

	if (!options.attached) {
		output.pipe(name, child.stdout, options.onText);
		output.pipe(name, child.stderr, options.onText);
	} else if (tee) {
		// Passed through unchanged. The feed gets a copy for the log, marked as
		// already on the terminal.
		child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
		output.pipe(name, child.stdout, options.onText, { echoed: true });
	}

	if (!options.waitForExit && child.unref) {
		child.unref();
	}

	return child;
}

/**
 * Argv running `command` under a pseudo-terminal whose output goes to stdout,
 * or null when this platform has no way to (checked with any command).
 *
 * `script` is on every macOS and on util-linux; the two disagree on syntax.
 * Without it the attached app keeps its terminal and its captures are not
 * seen, which the caller reports.
 */
export function ptyTeeArgv(command: string): [string, ...string[]] | null {
	if (process.platform === "darwin") {
		return ["script", "-q", "/dev/null", SHELL, "-c", command];
	}
	if (process.platform === "linux" && existsSync("/usr/bin/script")) {
		return ["script", "-q", "-f", "-e", "-c", command, "/dev/null"];
	}
	return null;
}

/**
 * Run an app's `prebuild` to completion, its output prefixed like the app's.
 * Cancelled with the run: a Ctrl-C during a slow build must not leave it
 * running behind the terminal.
 */
export async function runPrebuild(
	name: string,
	config: AppConfig,
	root: string,
	envVars: Record<string, string>,
	options: { signal: AbortSignal; output: RunOutput },
): Promise<void> {
	const command = config.prebuild;
	if (!command) return;
	options.signal.throwIfAborted();
	const child = spawnAppCommand(command, {
		...appSpawnOptions(config, root, envVars),
		stdio: ["ignore", "pipe", "pipe"],
	});
	options.output.pipe(name, child.stdout);
	options.output.pipe(name, child.stderr);

	const onAbort = () => void terminateOwnedProcess(child);
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
