import { execSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ExecOptions, ExecResult } from "../../types";

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
		const stdout = execSync(cmd, {
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
	cmd: string,
	root: string,
	envVars: Record<string, string>,
	options: ExecOptions = {},
): Promise<ExecResult> {
	const { cwd, verbose = false, env = {}, throwOnError = true } = options;

	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(cmd, [], {
			cwd: cwd ? resolve(root, cwd) : root,
			env: resolveCommandEnv(envVars, env),
			shell: true,
			stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += String(chunk);
		});

		child.on("error", (error) => {
			if (throwOnError) {
				rejectPromise(error);
				return;
			}
			resolvePromise({ exitCode: 1, stdout, stderr: error.message });
		});

		child.on("close", (code) => {
			const result: ExecResult = { exitCode: code ?? 1, stdout, stderr };
			if (throwOnError && result.exitCode !== 0) {
				rejectPromise(commandFailure(cmd, result));
				return;
			}
			resolvePromise(result);
		});
	});
}
