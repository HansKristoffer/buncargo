import { execSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ExecOptions, ExecResult } from "../../types";
import { abortError, registerAbortCleanup } from "../deadline";
import { recordStartupMetric } from "../startup-metrics";
import { terminateOwnedProcess } from "./terminate";

export type { ExecResult };

function resolveCommandEnv(
	envVars: Record<string, string>,
	env: Record<string, string>,
): NodeJS.ProcessEnv {
	return { ...process.env, ...envVars, ...env };
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
	options: ExecOptions = {},
): ExecResult {
	const { cwd, verbose = false, env = {}, throwOnError = true } = options;

	try {
		options.signal?.throwIfAborted();
		recordStartupMetric("subprocesses");
		const stdout = execSync(cmd, {
			timeout: options.timeoutMs,
			cwd: cwd ? resolve(root, cwd) : root,
			env: resolveCommandEnv(envVars, env),
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
 * Execute a shell command asynchronously.
 */
export async function execAsync(
	cmd: string | readonly string[],
	root: string,
	envVars: Record<string, string>,
	options: ExecOptions = {},
): Promise<ExecResult> {
	const {
		cwd,
		verbose = false,
		env = {},
		throwOnError = true,
		signal,
		timeoutMs,
		killGraceMs = 1000,
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
				env: resolveCommandEnv(envVars, env),
				shell: typeof cmd === "string",
				detached: true,
				stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		let cancelling = false;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: ExecResult, error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (throwOnError && (error || result.exitCode !== 0))
				rejectPromise(error ?? commandFailure(displayCommand, result));
			else resolvePromise(result);
		};
		const cancel = async (error: Error) => {
			if (settled || cancelling) return;
			cancelling = true;
			try {
				await terminateOwnedProcess(child, killGraceMs);
			} catch (cleanupError) {
				error = new AggregateError([error, cleanupError], error.message);
			}
			finish({ exitCode: 1, stdout, stderr: error.message }, error);
		};
		const onAbort = () => {
			const cleanup = cancel(abortError(signal));
			if (signal) registerAbortCleanup(signal, cleanup);
		};
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			if (!cancelling)
				finish({ exitCode: 1, stdout, stderr: error.message }, error);
		});
		child.on("close", (code) => {
			if (!cancelling) finish({ exitCode: code ?? 1, stdout, stderr });
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		if (timeoutMs !== undefined)
			timer = setTimeout(
				() => {
					void cancel(
						new Error(
							`Command timed out after ${timeoutMs}ms: ${displayCommand}`,
						),
					);
				},
				Math.max(0, timeoutMs),
			);
	});
}
