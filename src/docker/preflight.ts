import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isCI } from "../core/runtime-flags";

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

function commandExists(command: string): boolean {
	try {
		execSync(`command -v ${command}`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return true;
	} catch {
		return false;
	}
}

function dockerContextName(): string | null {
	try {
		return execSync("docker context show", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return null;
	}
}

export function detectDockerRuntime(): DockerRuntime {
	const context = dockerContextName()?.toLowerCase() ?? "";
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

export function isDockerDaemonRunning(): boolean {
	try {
		execSync('docker info --format "{{.ServerVersion}}"', {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return true;
	} catch {
		return false;
	}
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
}

export async function ensureDockerRunning(
	options: EnsureDockerRunningOptions = {},
): Promise<void> {
	const { autoStart = !isCI(), timeoutMs = 90_000, verbose = true } = options;

	if (isDockerDaemonRunning()) {
		return;
	}

	const runtime = detectDockerRuntime();
	if (!autoStart) {
		throw new DockerUnavailableError(runtime, remediationFor(runtime));
	}

	if (verbose) {
		console.log(`🐳 Docker is not running. Starting ${runtime}...`);
	}
	startRuntime(runtime);

	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		if (isDockerDaemonRunning()) {
			if (verbose) console.log("✓ Docker is ready");
			return;
		}
		if (verbose) {
			const elapsed = Math.round((Date.now() - startedAt) / 1000);
			console.log(`   ⏳ Waiting for Docker... (${elapsed}s)`);
		}
	}

	throw new DockerUnavailableError(runtime, remediationFor(runtime));
}
