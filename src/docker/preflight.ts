import { existsSync } from "node:fs";
import { abortableSleep, remainingTime } from "../core/deadline";
import { execAsync } from "../core/process/exec";
import { isCI } from "../core/runtime-flags";
import { formatDone, formatStep, formatWait } from "../core/style";
import { lookupOnPath } from "../core/tool-binary";
import { runDocker, runDockerAsync } from "./binary";

export type DockerRuntime =
	| "orbstack"
	| "docker-desktop"
	| "colima"
	| "rancher"
	| "podman"
	| "unknown";

export class DockerUnavailableError extends Error {
	readonly runtime: DockerRuntime;
	readonly remediation: string;

	constructor(runtime: DockerRuntime, remediation: string) {
		super(`Docker is not running (${runtime}). ${remediation}`);
		this.name = "DockerUnavailableError";
		this.runtime = runtime;
		this.remediation = remediation;
	}
}

/** A `PATH` scan, not a spawn: this runs while deciding how to report a failure. */
function commandExists(command: string): boolean {
	return lookupOnPath(command) !== undefined;
}

function dockerContextName(binary?: string): string | null {
	const result = runDocker(binary, ["context", "show"]);
	return result.ok ? result.stdout.trim() : null;
}

export function detectDockerRuntime(binary?: string): DockerRuntime {
	return runtimeFromContext(dockerContextName(binary)?.toLowerCase() ?? "");
}

function runtimeFromContext(context: string): DockerRuntime {
	if (
		context.includes("orbstack") ||
		existsSync("/Applications/OrbStack.app")
	) {
		return "orbstack";
	}
	if (context.includes("colima") || commandExists("colima")) {
		return "colima";
	}
	if (
		context.includes("rancher") ||
		existsSync("/Applications/Rancher Desktop.app")
	) {
		return "rancher";
	}
	if (context.includes("podman") || commandExists("podman")) {
		return "podman";
	}
	if (existsSync("/Applications/Docker.app") || commandExists("docker")) {
		return "docker-desktop";
	}
	return "unknown";
}

export function isDockerDaemonRunning(binary?: string): boolean {
	return runDocker(binary, ["info", "--format", "{{.ServerVersion}}"]).ok;
}

function remediationFor(runtime: DockerRuntime): string {
	switch (runtime) {
		case "orbstack":
			return "Start OrbStack (open -a OrbStack) and try again.";
		case "docker-desktop":
			return "Start Docker Desktop (open -a Docker) and try again.";
		case "colima":
			return "Run `colima start` and try again.";
		case "rancher":
			return 'Start Rancher Desktop (open -a "Rancher Desktop") and try again.';
		case "podman":
			return "Start the Podman machine (`podman machine start`) and try again.";
		default:
			return "Start Docker and try again.";
	}
}

function runtimeStartCommand(runtime: DockerRuntime): string[] | undefined {
	switch (runtime) {
		case "orbstack":
			return ["open", "-a", "OrbStack"];
		case "docker-desktop":
			return ["open", "-a", "Docker"];
		case "colima":
			return ["colima", "start"];
		case "rancher":
			return ["open", "-a", "Rancher Desktop"];
		case "podman":
			return ["podman", "machine", "start"];
		default:
			return undefined;
	}
}

export interface EnsureDockerRunningOptions {
	signal?: AbortSignal;
	autoStart?: boolean;
	timeoutMs?: number;
	verbose?: boolean;
	binary?: string;
}

export async function ensureDockerRunning(
	options: EnsureDockerRunningOptions = {},
): Promise<void> {
	const {
		autoStart = !isCI(),
		timeoutMs = 90_000,
		verbose = true,
		binary,
	} = options;

	const { signal } = options;
	const deadline = performance.now() + timeoutMs;
	const daemonRunning = async () =>
		(
			await runDockerAsync(binary, ["info", "--format", "{{.ServerVersion}}"], {
				signal,
				timeoutMs: Math.min(5000, remainingTime(deadline)),
			})
		).ok;
	if (await daemonRunning()) return;
	const context = await runDockerAsync(binary, ["context", "show"], {
		signal,
		timeoutMs: Math.min(5000, remainingTime(deadline)),
	});
	const runtime = runtimeFromContext(
		context.ok ? context.stdout.trim().toLowerCase() : "",
	);
	if (!autoStart)
		throw new DockerUnavailableError(runtime, remediationFor(runtime));
	if (verbose)
		console.log(formatStep(`🐳 Docker is not running. Starting ${runtime}...`));
	const command = runtimeStartCommand(runtime);
	if (command && remainingTime(deadline) > 0)
		await execAsync(
			command,
			process.cwd(),
			{},
			{
				signal,
				timeoutMs: remainingTime(deadline),
				killGraceMs: 0,
				throwOnError: false,
			},
		);
	while (remainingTime(deadline) > 0) {
		signal?.throwIfAborted();
		if (await daemonRunning()) {
			if (verbose) console.log(formatDone("Docker is ready"));
			return;
		}
		await abortableSleep(Math.min(1000, remainingTime(deadline)), signal);
		if (verbose)
			console.log(
				formatWait(
					`Waiting for Docker... (${Math.round((timeoutMs - remainingTime(deadline)) / 1000)}s)`,
				),
			);
	}
	signal?.throwIfAborted();
	throw new DockerUnavailableError(runtime, remediationFor(runtime));
}
