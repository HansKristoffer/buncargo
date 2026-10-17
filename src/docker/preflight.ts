import { existsSync } from "node:fs";
import { abortableSleep, remainingTime } from "../core/deadline";
import { execAsync } from "../core/process/exec";
import { isCI } from "../core/runtime-flags";
import { formatDone, formatStep, formatWait } from "../core/style";
import { lookupOnPath } from "../core/tool-binary";
import { DEFAULT_DOCKER_BINARY, runDocker, runDockerAsync } from "./binary";

export type DockerRuntime =
	| "orbstack"
	| "docker-desktop"
	/** The plain engine on Linux, run by the system service manager. */
	| "docker-engine"
	| "colima"
	| "rancher"
	| "podman"
	| "unknown";

export class DockerUnavailableError extends Error {
	readonly runtime: DockerRuntime;
	readonly remediation: string;

	constructor(
		runtime: DockerRuntime,
		remediation: string,
		problem = `Docker is not running (${runtime}).`,
	) {
		super(`${problem} ${remediation}`);
		this.name = "DockerUnavailableError";
		this.runtime = runtime;
		this.remediation = remediation;
	}
}

/** A `PATH` scan, not a spawn: this runs while deciding how to report a failure. */
function commandExists(command: string): boolean {
	return lookupOnPath(command) !== undefined;
}

/** Exported for tests: the platform decides what a bare `docker` binary means. */
export function runtimeFromContext(
	context: string,
	platform: NodeJS.Platform = process.platform,
	binary: string = DEFAULT_DOCKER_BINARY,
): DockerRuntime {
	// On Linux the context decides, not which other tools are installed: a CI image
	// with podman on PATH still runs Docker's own engine under the "default" context.
	// Anything not named for another runtime (or Docker Desktop) is that engine,
	// which nothing here can or should start.
	const otherRuntime = /colima|rancher|podman|desktop-linux/.test(context);
	if (platform === "linux" && !otherRuntime) {
		return "docker-engine";
	}
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
	if (existsSync("/Applications/Docker.app") || commandExists(binary)) {
		return "docker-desktop";
	}
	return "unknown";
}

export function isDockerDaemonRunning(binary?: string): boolean {
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
		case "docker-engine":
			return "Start the Docker service (sudo systemctl start docker) and try again.";
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
	const probe = () =>
		runDockerAsync(binary, ["version", "--format", "{{.Server.Version}}"], {
			signal,
			timeoutMs: Math.min(5000, remainingTime(deadline)),
		});
	const daemonRunning = async () => (await probe()).ok;
	const first = await probe();
	if (first.ok) return;
	const context = await runDockerAsync(binary, ["context", "show"], {
		signal,
		timeoutMs: Math.min(5000, remainingTime(deadline)),
	});
	const runtime = runtimeFromContext(
		context.ok ? context.stdout.trim().toLowerCase() : "",
		process.platform,
		binary,
	);
	// A daemon that is up but refuses this user would otherwise read as "not
	// running", and the wait below could never end differently.
	if (/permission denied/i.test(first.stderr))
		throw new DockerUnavailableError(
			runtime,
			"Add your user to the docker group (sudo usermod -aG docker $USER), then log in again or restart the service you run buncargo from: running processes keep their old groups.",
			"Docker is running, but this user cannot open its socket.",
		);
	// CI never starts Docker itself, but a runner's daemon is often still
	// coming up when the job starts: keep asking until the deadline. Locally,
	// `--no-docker-autostart` wants the answer now, not in 90 seconds, and so
	// does a runtime nothing here can start (the Linux engine): no daemon is
	// coming while we wait.
	const waitOnly = !autoStart && ci;
	const command = waitOnly ? undefined : runtimeStartCommand(runtime);
	if (!waitOnly && (!autoStart || command === undefined))
		throw new DockerUnavailableError(runtime, remediationFor(runtime));
	if (verbose && !waitOnly)
		console.log(formatStep(`🐳 Docker is not running. Starting ${runtime}...`));
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
