import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { execAsync } from "../core/process/exec";
import { recordStartupMetric } from "../core/startup-metrics";
import { lookupOnPath } from "../core/tool-binary";

/**
 * The one place Apple's `container` binary is executed.
 *
 * Injectable so the lifecycle and status layers can be tested without the
 * runtime installed. Spawned as argv without a shell, so nothing here has to
 * quote a volume path or an image argument, matching the Docker backend.
 */

export interface AppleCliResult {
	ok: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface AppleCliOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	cwd?: string;
	env?: Record<string, string>;
	/** Stream to the terminal instead of capturing. */
	inherit?: boolean;
}

export interface AppleContainerCli {
	/** Absolute path or bare command name being executed. */
	readonly binary: string;
	/** Whether the binary could be found at all. */
	readonly found: boolean;
	run(args: string[], options?: AppleCliOptions): AppleCliResult;
	runAsync?(args: string[], options?: AppleCliOptions): Promise<AppleCliResult>;
}

export const APPLE_CONTAINER_COMMAND = "container";

export function createAppleContainerCli(
	options: { binary?: string } = {},
): AppleContainerCli {
	const override = options.binary;
	const resolved =
		override ??
		lookupOnPath(APPLE_CONTAINER_COMMAND) ??
		APPLE_CONTAINER_COMMAND;
	const found = override
		? existsSync(override)
		: resolved !== APPLE_CONTAINER_COMMAND;

	return {
		binary: resolved,
		found,
		async runAsync(args, runOptions = {}) {
			const result = await execAsync(
				[resolved, ...args],
				runOptions.cwd ?? process.cwd(),
				runOptions.env ?? {},
				{
					verbose: runOptions.inherit,
					throwOnError: false,
					signal: runOptions.signal,
					timeoutMs: runOptions.timeoutMs ?? 10000,
					killGraceMs: 0,
				},
			);
			runOptions.signal?.throwIfAborted();
			return { ...result, ok: result.exitCode === 0 };
		},
		run(args, runOptions = {}) {
			recordStartupMetric("subprocesses");
			const result = spawnSync(resolved, args, {
				cwd: runOptions.cwd,
				timeout: runOptions.timeoutMs ?? 10000,
				killSignal: "SIGKILL",
				encoding: "utf-8",
				env: runOptions.env
					? { ...process.env, ...runOptions.env }
					: process.env,
				stdio: runOptions.inherit
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
		},
	};
}

/** Apple phrases "no such container" several ways depending on the subcommand. */
export function isMissingResourceMessage(message: string): boolean {
	return /not found|no such|does not exist|unknown container|not exist/i.test(
		message,
	);
}

export function isAlreadyExistsMessage(message: string): boolean {
	return /already exists|already in use|exists/i.test(message);
}

/** Injected legacy CLIs remain compatible; real CLIs always execute asynchronously. */
export async function runAppleAsync(
	cli: AppleContainerCli,
	args: string[],
	options: AppleCliOptions = {},
): Promise<AppleCliResult> {
	options.signal?.throwIfAborted();
	return cli.runAsync ? cli.runAsync(args, options) : cli.run(args, options);
}
