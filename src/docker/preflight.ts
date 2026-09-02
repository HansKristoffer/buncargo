import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isCI } from "../core/runtime-flags";
import { formatDone, formatStep, formatWait } from "../core/style";
import { lookupOnPath } from "../core/tool-binary";
import { runDocker } from "./binary";

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
	const context = dockerContextName(binary)?.toLowerCase() ?? "";
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

function startRuntime(runtime: DockerRuntime): void {
	switch (runtime) {
		case "orbstack":
			spawn("open", ["-a", "OrbStack"], {
				detached: true,
				stdio: "ignore",
			}).unref();
			return;
		case "docker-desktop":
			spawn("open", ["-a", "Docker"], {
				detached: true,
				stdio: "ignore",
			}).unref();
			return;
		case "colima":
			spawn("colima", ["start"], { detached: true, stdio: "ignore" }).unref();
			return;
		case "rancher":
			spawn("open", ["-a", "Rancher Desktop"], {
				detached: true,
				stdio: "ignore",
			}).unref();
			return;
		case "podman":
			spawn("podman", ["machine", "start"], {
				detached: true,
				stdio: "ignore",
			}).unref();
			return;
		default:
			return;
	}
}

export interface EnsureDockerRunningOptions {
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

	if (isDockerDaemonRunning(binary)) {
		return;
	}

	const runtime = detectDockerRuntime(binary);
	if (!autoStart) {
		throw new DockerUnavailableError(runtime, remediationFor(runtime));
	}

	if (verbose) {
		console.log(formatStep(`🐳 Docker is not running. Starting ${runtime}...`));
	}
	startRuntime(runtime);

	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		if (isDockerDaemonRunning(binary)) {
			if (verbose) console.log(formatDone("Docker is ready"));
			return;
		}
		if (verbose) {
			const elapsed = Math.round((Date.now() - startedAt) / 1000);
			console.log(formatWait(`Waiting for Docker... (${elapsed}s)`));
		}
	}

	throw new DockerUnavailableError(runtime, remediationFor(runtime));
}
