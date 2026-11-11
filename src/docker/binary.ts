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
import { lookupOnPath } from "../core/tool-binary";

export const DEFAULT_DOCKER_BINARY = "docker";

/**
 * What a person runs to remove a Compose project's containers and networks by
 * name, volumes kept: what buncargo's own teardown does.
 */
export function manualComposeDownCommand(projectName: string): string {
	return `${DEFAULT_DOCKER_BINARY} compose -p ${projectName} down`;
}

/**
 * How one `docker` invocation ended: it exited 0, exited with another code,
 * could not start because there is no such binary, or was killed at its
 * timeout. A missing binary is not a daemon that refused, and the two paths
 * that run `docker` must say so the same way.
 */
export type DockerRunStatus = "ok" | "exit" | "notFound" | "timedOut";

export interface DockerRunResult {
	status: DockerRunStatus;
	/** `status === "ok"`, kept for the many callers that only ask that. */
	ok: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
}

function runResult(
	status: DockerRunStatus,
	exitCode: number,
	stdout: string,
	stderr: string,
): DockerRunResult {
	return { status, ok: status === "ok", exitCode, stdout, stderr };
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
		const { error } = result;
		const code = "code" in error ? error.code : undefined;
		const status: DockerRunStatus =
			code === "ENOENT"
				? "notFound"
				: code === "ETIMEDOUT"
					? "timedOut"
					: "exit";
		return runResult(status, 1, "", error.message);
	}

	const exitCode = result.status ?? 1;
	return runResult(
		exitCode === 0 ? "ok" : "exit",
		exitCode,
		result.stdout ?? "",
		result.stderr ?? "",
	);
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
	const { exitCode, stdout, stderr } = result;
	if (result.timedOut) return runResult("timedOut", exitCode, stdout, stderr);
	if (exitCode === 0) return runResult("ok", exitCode, stdout, stderr);
	// The async spawn reports a missing binary as a failed exit with Node's
	// code dropped, so the failure path asks the PATH itself: a scan, no fork.
	const env = { ...process.env, ...options.env };
	const missing = lookupOnPath(binary, env) === undefined;
	return runResult(missing ? "notFound" : "exit", exitCode, stdout, stderr);
}
