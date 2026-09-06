/**
 * The `docker` binary every command in this folder is built from.
 *
 * Kept in one leaf module so `docker.binary` / `BUNCARGO_CONTAINER_BINARY` has
 * a single place to reach, rather than each command string spelling `docker`
 * itself and quietly ignoring the override.
 */

import { spawnSync } from "node:child_process";
import { execAsync } from "../core/process/exec";
import { recordStartupMetric } from "../core/startup-metrics";

export const DEFAULT_DOCKER_BINARY = "docker";

export interface DockerRunResult {
	ok: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface DockerRunOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	cwd?: string;
	env?: Record<string, string>;
	/** Stream to the terminal instead of capturing. */
	inherit?: boolean;
}

/**
 * Run `docker` as argv, without a shell.
 *
 * Every command in this folder goes through here so no caller has to reason
 * about quoting a project name, a compose path or a binary path that contains
 * a space, and so the two backends execute the same way.
 */
export function runDocker(
	binary: string = DEFAULT_DOCKER_BINARY,
	args: string[],
	options: DockerRunOptions = {},
): DockerRunResult {
	recordStartupMetric("subprocesses");
	const result = spawnSync(binary, args, {
		cwd: options.cwd,
		timeout: options.timeoutMs ?? 10000,
		killSignal: "SIGKILL",
		encoding: "utf-8",
		env: options.env ? { ...process.env, ...options.env } : process.env,
		stdio: options.inherit
			? ["pipe", "inherit", "inherit"]
			: ["pipe", "pipe", "pipe"],
	});

	if (result.error) {
		return {
			ok: false,
			exitCode: 1,
			stdout: "",
			stderr: result.error.message,
		};
	}

	const exitCode = result.status ?? 1;
	return {
		ok: exitCode === 0,
		exitCode,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

/** Async runtime execution keeps cancellation responsive during pulls and probes. */
export async function runDockerAsync(
	binary: string = DEFAULT_DOCKER_BINARY,
	args: string[],
	options: DockerRunOptions = {},
): Promise<DockerRunResult> {
	const result = await execAsync(
		[binary, ...args],
		options.cwd ?? process.cwd(),
		options.env ?? {},
		{
			verbose: options.inherit,
			throwOnError: false,
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? 10000,
			killGraceMs: 0,
		},
	);
	options.signal?.throwIfAborted();
	return { ...result, ok: result.exitCode === 0 };
}
