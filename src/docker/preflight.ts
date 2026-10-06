import { existsSync } from "node:fs";
import { abortableSleep, remainingTime } from "../core/deadline";
import { execAsync } from "../core/process/exec";
import { isCI } from "../core/runtime-flags";
import { formatDone, formatStep, formatWait } from "../core/style";
import { lookupOnPath } from "../core/tool-binary";
import { type DockerBinary, runDocker, runDockerAsync } from "./binary";

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

function dockerContextName(binary?: DockerBinary): string | null {
	const result = runDocker(binary, ["context", "show"]);
	return result.ok ? result.stdout.trim() : null;
}

export function detectDockerRuntime(binary?: DockerBinary): DockerRuntime {
	return runtimeFromContext(dockerContextName(binary)?.toLowerCase() ?? "");
}

/**
 * Which engine a Docker context belongs to.
 *
 * The context decides when it names one: with Docker Desktop selected,
 * OrbStack merely being installed must not make buncargo start OrbStack and
 * then wait for a Docker Desktop socket that never comes up. Installed apps
 * only break the tie for a context that names no engine (`default`).
 */
export function runtimeFromContext(context: string): DockerRuntime {
	if (context.includes("orbstack")) return "orbstack";
	if (context.startsWith("desktop-")) return "docker-desktop";
	if (context.includes("colima")) return "colima";
	if (context.includes("rancher")) return "rancher";
	if (context.includes("podman")) return "podman";
	if (existsSync("/Applications/OrbStack.app")) return "orbstack";
	if (commandExists("colima")) return "colima";
	if (existsSync("/Applications/Rancher Desktop.app")) return "rancher";
	if (commandExists("podman")) return "podman";
	if (existsSync("/Applications/Docker.app") || commandExists("docker")) {
		return "docker-desktop";
	}
	return "unknown";
}

export function isDockerDaemonRunning(binary?: DockerBinary): boolean {
	// `info` also inspects CLI plugins, whose metadata can stall a healthy
	// daemon's probe. `version` asks the server without that extra discovery.
	return runDocker(binary, ["version", "--format", "{{.Server.Version}}"]).ok;
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
	binary?: DockerBinary;
	/** The engine to start, when the caller already knows it; otherwise read from the context. */
	engine?: DockerRuntime;
	/** Whether this is CI, where a down daemon is waited for rather than started. */
	ci?: boolean;
}

export async function ensureDockerRunning(
	options: EnsureDockerRunningOptions = {},
): Promise<void> {
	const {
		ci = isCI(),
		autoStart = !ci,
		timeoutMs = 90_000,
		verbose = true,
		binary,
	} = options;

	const { signal } = options;
	const deadline = performance.now() + timeoutMs;
	const daemonRunning = async () =>
		(
			await runDockerAsync(
				binary,
				["version", "--format", "{{.Server.Version}}"],
				{
					signal,
					timeoutMs: Math.min(5000, remainingTime(deadline)),
				},
			)
		).ok;
	if (await daemonRunning()) return;
	const runtime =
		options.engine ??
		runtimeFromContext(
			await runDockerAsync(binary, ["context", "show"], {
				signal,
				timeoutMs: Math.min(5000, remainingTime(deadline)),
			}).then((context) =>
				context.ok ? context.stdout.trim().toLowerCase() : "",
			),
		);
	// CI never starts Docker itself, but a runner's daemon is often still
	// coming up when the job starts: keep asking until the deadline. Locally,
	// `--no-docker-autostart` wants the answer now, not in 90 seconds.
	const waitOnly = !autoStart && ci;
	if (!autoStart && !waitOnly)
		throw new DockerUnavailableError(runtime, remediationFor(runtime));
	if (verbose && !waitOnly)
		console.log(formatStep(`🐳 Docker is not running. Starting ${runtime}...`));
	const command = waitOnly ? undefined : runtimeStartCommand(runtime);
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
