import { type ChildProcess, execSync, spawn } from "node:child_process";
import { constants } from "node:os";
import { resolve } from "node:path";
import type { ExecOptions, ExecResult } from "../../types";
import { childProcessEnv } from "../child-env";
import { abortError, registerAbortCleanup } from "../deadline";
import { recordStartupMetric } from "../startup-metrics";
import { formatPrefixedLine, isBlankLogLine } from "../style";
import { forEachLine } from "./line-splitter";
import { terminateOwnedProcess } from "./terminate";

export type { ExecResult };

export class CommandSignalError extends Error {
	constructor(readonly signal: NodeJS.Signals) {
		super(`Command interrupted by ${signal}`);
	}
}

class CommandTimeoutError extends Error {}

/** What `execAsync` resolves with. */
export interface CommandResult extends ExecResult {
	/**
	 * Killed at `timeoutMs` rather than exiting on its own. A probe cut off
	 * there did not answer, which is not the same as answering "no".
	 */
	timedOut: boolean;
}

/**
 * A child's exit as a shell reports it: its code, or 128 plus the signal
 * that killed it. A signalled child has no code, and reading that as 0 made
 * a killed command look like it succeeded.
 */
export function shellExitCode(
	code: number | null,
	signal: NodeJS.Signals | null,
): number {
	if (code !== null) return code;
	return signal ? 128 + constants.signals[signal] : 1;
}

/** The config's `unsetEnv`, which the environment running the command passes. */
type UnsetEnvOption = { unsetEnv?: readonly string[] };

function resolveCommandEnv(
	envVars: Record<string, string>,
	env: Record<string, string>,
	unsetEnv: readonly string[] | undefined,
): NodeJS.ProcessEnv {
	return childProcessEnv({ ...process.env, ...envVars, ...env }, unsetEnv);
}

function commandFailure(cmd: string, result: ExecResult): Error {
	return new Error(
		`Command failed with exit code ${result.exitCode}: ${cmd}\n${result.stderr}`,
	);
}

/**
 * Execute a shell command with environment variables.
 */
export function exec(
	cmd: string,
	root: string,
	envVars: Record<string, string>,
	options: ExecOptions & UnsetEnvOption = {},
): ExecResult {
	const { cwd, verbose = false, env = {}, throwOnError = true } = options;

	try {
		options.signal?.throwIfAborted();
		recordStartupMetric("subprocesses");
		const stdout = execSync(cmd, {
			timeout: options.timeoutMs,
			cwd: cwd ? resolve(root, cwd) : root,
			env: resolveCommandEnv(envVars, env, options.unsetEnv),
			encoding: "utf-8",
			stdio: verbose ? "inherit" : ["pipe", "pipe", "pipe"],
		});

		return {
			exitCode: 0,
			stdout: typeof stdout === "string" ? stdout : "",
			stderr: "",
		};
	} catch (error) {
		const execError = error as {
			status?: number;
			stdout?: string;
			stderr?: string;
		};
		const result: ExecResult = {
			exitCode: execError.status ?? 1,
			stdout: execError.stdout ?? "",
			stderr: execError.stderr ?? "",
		};

		if (throwOnError) {
			throw commandFailure(cmd, result);
		}

		return result;
	}
}

/**
 * Execute a shell command asynchronously. With `verbose`, `onOutputLine`
 * takes each line of output instead of the terminal.
 */
export async function execAsync(
	cmd: string | readonly string[],
	root: string,
	envVars: Record<string, string>,
	options: ExecOptions &
		UnsetEnvOption & { onOutputLine?: (line: string) => void } = {},
): Promise<CommandResult> {
	const {
		cwd,
		verbose = false,
		env = {},
		throwOnError = true,
		signal,
		timeoutMs,
		killGraceMs = 1000,
		maxBufferBytes,
		outputPrefix,
		onOutputLine,
	} = options;
	signal?.throwIfAborted();
	const executable = typeof cmd === "string" ? cmd : cmd[0];
	if (!executable) throw new Error("Command cannot be empty");
	const displayCommand = typeof cmd === "string" ? cmd : cmd.join(" ");
	return new Promise((resolvePromise, rejectPromise) => {
		recordStartupMetric("subprocesses");
		const child = spawn(
			executable,
			typeof cmd === "string" ? [] : [...cmd.slice(1)],
			{
				cwd: cwd ? resolve(root, cwd) : root,
				env: resolveCommandEnv(envVars, env, options.unsetEnv),
				shell: typeof cmd === "string",
				detached: true,
				stdio:
					verbose && !outputPrefix && !onOutputLine
						? "inherit"
						: ["ignore", "pipe", "pipe"],
			},
		);
		if (verbose && onOutputLine) forEachOutputLine(child, onOutputLine);
		else if (verbose && outputPrefix)
			forEachOutputLine(child, (line) =>
				process.stdout.write(
					formatPrefixedLine(outputPrefix, line, outputPrefix.length),
				),
			);
		let stdout = "";
		let stderr = "";
		let cancelling = false;
		let settled = false;
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: ExecResult, error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (throwOnError && (error || result.exitCode !== 0))
				rejectPromise(error ?? commandFailure(displayCommand, result));
			else
				resolvePromise({
					...result,
					timedOut,
				});
		};
		const cancel = async (error: Error) => {
			if (settled || cancelling) return;
			cancelling = true;
			timedOut = error instanceof CommandTimeoutError;
			try {
				await terminateOwnedProcess(
					child,
					killGraceMs,
					error instanceof CommandSignalError ? error.signal : "SIGTERM",
				);
			} catch (cleanupError) {
				error = new AggregateError([error, cleanupError], error.message);
			}
			finish({ exitCode: 1, stdout, stderr: error.message }, error);
		};
		const onAbort = () => {
			const cleanup = cancel(abortError(signal));
			if (signal) registerAbortCleanup(signal, cleanup);
		};
		let outputBytes = 0;
		const collect = (chunk: Buffer | string, stream: "stdout" | "stderr") => {
			if (cancelling || settled) return;
			outputBytes += Buffer.byteLength(chunk);
			if (maxBufferBytes !== undefined && outputBytes > maxBufferBytes) {
				void cancel(
					new Error(`Command output exceeded ${maxBufferBytes} bytes`),
				);
				return;
			}
			if (stream === "stdout") stdout += String(chunk);
			else stderr += String(chunk);
		};
		child.stdout?.on("data", (chunk: Buffer | string) =>
			collect(chunk, "stdout"),
		);
		child.stderr?.on("data", (chunk: Buffer | string) =>
			collect(chunk, "stderr"),
		);
		child.on("error", (error) => {
			if (!cancelling)
				finish({ exitCode: 1, stdout, stderr: error.message }, error);
		});
		child.on("close", (code, signal) => {
			if (!cancelling)
				finish({
					exitCode: shellExitCode(code, signal),
					stdout,
					stderr,
				});
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		if (timeoutMs !== undefined)
			timer = setTimeout(
				() => {
					void cancel(
						new CommandTimeoutError(
							`Command timed out after ${timeoutMs}ms: ${displayCommand}`,
						),
					);
				},
				Math.max(0, timeoutMs),
			);
	});
}

/** Each non-blank line of a piped child's stdout and stderr. */
function forEachOutputLine(
	child: ChildProcess,
	onLine: (line: string) => void,
): void {
	const handlers = {
		onLine: (line: string) => {
			if (!isBlankLogLine(line)) onLine(line);
		},
	};
	forEachLine(child.stdout, handlers);
	forEachLine(child.stderr, handlers);
}
