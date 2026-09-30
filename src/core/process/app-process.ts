import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "../../types";
import { connectProcessEnv } from "../runtime-flags";
import { shellQuote } from "../shell-quote";
import { recordStartupMetric } from "../startup-metrics";
import { formatPrefixedLine, isBlankLogLine } from "../style";
import { terminateOwnedProcess } from "./terminate";

/**
 * Spawning one app process: the shell it runs under, its prefixed output,
 * the pseudo-terminal tee that lets captures read an attached app, and its
 * prebuild. `dev-servers.ts` orchestrates many of these.
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

function prefixStream(
	name: string,
	stream: NodeJS.ReadableStream | null,
	options: {
		width: number;
		onFirstWrite: () => void;
		onText?: (text: string) => void;
	},
): void {
	if (!stream) {
		return;
	}

	let buffer = "";
	const writeLine = (line: string) => {
		if (isBlankLogLine(line)) {
			return;
		}
		options.onFirstWrite();
		process.stdout.write(formatPrefixedLine(name, line, options.width));
	};
	stream.on("data", (chunk: Buffer | string) => {
		options.onText?.(String(chunk));
		buffer += String(chunk);
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			writeLine(line);
		}
	});
	stream.on("end", () => {
		if (buffer) {
			writeLine(buffer);
		}
	});
}

/** Both output streams of a piped child, prefixed with its name. */
function prefixOutput(
	name: string,
	child: ChildProcess,
	options: Parameters<typeof prefixStream>[2],
): void {
	prefixStream(name, child.stdout, options);
	prefixStream(name, child.stderr, options);
}

/** Where and with what env an app's commands run, in their own process group. */
function appSpawnOptions(
	config: AppConfig,
	root: string,
	envVars: Record<string, string>,
) {
	return {
		cwd: config.cwd ? resolve(root, config.cwd) : root,
		env: connectProcessEnv({ ...process.env, ...envVars }),
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
		prefixWidth: number;
		onFirstLog: () => void;
		/** Raw output, for `captures`. */
		onText?: (text: string) => void;
	},
): ChildProcess {
	const baseCommand = resolveStartCommand(config, options.productionBuild);
	if (baseCommand === undefined) {
		throw new Error(`App "${name}" has no startable devCommand`);
	}

	const command =
		options.attached && options.extraArgs.length > 0
			? `${baseCommand} ${options.extraArgs.map(shellQuote).join(" ")}`
			: baseCommand;
	const base = appSpawnOptions(config, root, envVars);

	// The attached app keeps its terminal. Capturing from it needs its output
	// too, so it runs under a pseudo-terminal (`script`) whose copy of the
	// output passes through here unchanged; TUIs like Shopify CLI see a TTY.
	// Without a terminal to keep (CI, a test) plain pipes do the same job.
	const capturing = options.attached && options.onText !== undefined;
	const tee = capturing && process.stdin.isTTY ? ptyTeeArgv(command) : null;
	const piped = capturing && !process.stdin.isTTY;
	if (tee) recordStartupMetric("subprocesses");
	const child = tee
		? spawn(tee[0], tee.slice(1), {
				...base,
				stdio: ["inherit", "pipe", "inherit"],
			})
		: spawnAppCommand(command, {
				...base,
				stdio: !options.attached
					? ["ignore", "pipe", "pipe"]
					: piped
						? ["inherit", "pipe", "pipe"]
						: "inherit",
			});

	if (!options.attached) {
		prefixOutput(name, child, {
			width: options.prefixWidth,
			onFirstWrite: options.onFirstLog,
			onText: options.onText,
		});
	} else if (tee || piped) {
		// Passed through unchanged; stderr is only piped without the tee.
		for (const [stream, target] of [
			[child.stdout, process.stdout],
			[child.stderr, process.stderr],
		] as const) {
			stream?.on("data", (chunk: Buffer) => {
				target.write(chunk);
				options.onText?.(chunk.toString("utf8"));
			});
		}
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
	options: { signal: AbortSignal; width: number; onFirstLog: () => void },
): Promise<void> {
	const command = config.prebuild;
	if (!command) return;
	options.signal.throwIfAborted();
	const child = spawnAppCommand(command, {
		...appSpawnOptions(config, root, envVars),
		stdio: ["ignore", "pipe", "pipe"],
	});
	prefixOutput(name, child, {
		width: options.width,
		onFirstWrite: options.onFirstLog,
	});

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
