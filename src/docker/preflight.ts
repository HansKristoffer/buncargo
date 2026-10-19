import { existsSync } from "node:fs";
import { abortableSleep, remainingTime } from "../core/deadline";
import { execAsync } from "../core/process/exec";
import { askConfirm, isInteractive } from "../core/prompt";
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
		problem = runtime === "unknown"
			? "Docker is not running."
			: `Docker is not running (${runtime}).`,
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

export function remediationFor(runtime: DockerRuntime): string {
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

/**
 * Docker Desktop's own processes, by executable name. Quitting the app can
 * leave `com.docker.backend` running with a socket that never answers, which
 * reads as "not running" while `open -a Docker` does nothing about it. The
 * root helper (`com.docker.vmnetd`) is not ours to signal.
 */
const DOCKER_DESKTOP_PROCESSES = new Set([
	"Docker Desktop",
	"com.docker.backend",
	"com.docker.build",
	"com.docker.virtualization",
]);

/** The pids of this user's Docker Desktop processes in `ps -axo pid=,uid=,comm=` output. */
export function parseDockerDesktopPids(
	psOutput: string,
	uid: number,
): number[] {
	const pids: number[] = [];
	for (const line of psOutput.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
		if (!match) continue;
		const [, pid, owner, command] = match;
		const name = command.trim().split("/").at(-1) ?? "";
		if (Number(owner) === uid && DOCKER_DESKTOP_PROCESSES.has(name))
			pids.push(Number(pid));
	}
	return pids;
}

/** Docker Desktop processes of this user still running; only asked once the daemon failed. */
function runningDockerDesktopPids(): number[] {
	const uid = process.getuid?.();
	if (process.platform !== "darwin" || uid === undefined) return [];
	const result = Bun.spawnSync(["ps", "-axo", "pid=,uid=,comm="], {
		stdout: "pipe",
		stderr: "ignore",
	});
	return result.success
		? parseDockerDesktopPids(result.stdout.toString(), uid)
		: [];
}

/**
 * Docker Desktop is up but its daemon does not answer: what `doctor --fix`
 * force-restarts. Distinct from "not running", which `open -a Docker` fixes.
 */
export function unresponsiveDockerError(
	pids: readonly number[],
): DockerUnavailableError {
	return new DockerUnavailableError(
		"docker-desktop",
		"Run `buncargo doctor --fix` to force-restart it, or quit Docker Desktop, end com.docker.backend in Activity Monitor and start it again (open -a Docker).",
		`Docker Desktop is running (pid ${pids.join(", ")}) but its daemon is not answering: it is still starting, or it hung.`,
	);
}

/** `ps -o etime=`: `[[dd-]hh:]mm:ss`, as milliseconds. */
export function parseElapsed(etime: string): number | undefined {
	const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(etime);
	if (!match) return undefined;
	const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
	return (
		((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000 +
		Number(seconds) * 1000
	);
}

/**
 * How long the newest of these processes has run; undefined when `ps` cannot
 * say. The newest, because a backend Docker Desktop just restarted is starting
 * however long the app around it has run.
 */
function youngestUptimeMs(pids: readonly number[]): number | undefined {
	const result = Bun.spawnSync(["ps", "-o", "etime=", "-p", pids.join(",")], {
		stdout: "pipe",
		stderr: "ignore",
	});
	if (!result.success) return undefined;
	const ages = result.stdout
		.toString()
		.split("\n")
		.map(parseElapsed)
		.filter((age) => age !== undefined);
	return ages.length > 0 ? Math.min(...ages) : undefined;
}

/** A cold Docker Desktop start took about 65 s on a loaded machine; this is well past it. */
export const DESKTOP_COLD_START_MS = 150_000;

/**
 * Whether a Docker Desktop that runs without answering is hung rather than
 * starting. Killing one that is starting hard-stops every checkout's
 * containers for nothing, so only a process past a cold start counts.
 */
export function isDockerDesktopHung(uptimeMs: number): boolean {
	return uptimeMs >= DESKTOP_COLD_START_MS;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * End Docker Desktop's processes and start it again. Only the pids just
 * listed for this user, by pid; a quit request leaves the backend alive in
 * exactly the state this is for, so SIGTERM gets a few seconds before
 * SIGKILL.
 */
async function forceRestartDockerDesktop(
	pids: readonly number[],
	signal?: AbortSignal,
): Promise<void> {
	const signalAll = (name: NodeJS.Signals) => {
		for (const pid of pids) {
			try {
				process.kill(pid, name);
			} catch {
				// Already gone.
			}
		}
	};
	signalAll("SIGTERM");
	const deadline = performance.now() + 10_000;
	while (pids.some(isAlive) && remainingTime(deadline) > 0)
		await abortableSleep(250, signal);
	signalAll("SIGKILL");
	await abortableSleep(1000, signal);
	// `open` returns before the app is up; the caller waits for the daemon.
	await execAsync(
		["open", "-a", "Docker"],
		process.cwd(),
		{},
		{
			signal,
			timeoutMs: 30_000,
			throwOnError: false,
		},
	);
}

/** How long a restarted Docker Desktop gets to answer. */
const RESTART_TIMEOUT_MS = 150_000;

export interface EnsureDockerRunningOptions {
	signal?: AbortSignal;
	autoStart?: boolean;
	timeoutMs?: number;
	verbose?: boolean;
	binary?: string;
	/** Whether this is CI, where a down daemon is waited for rather than started. */
	ci?: boolean;
	/** Kill and restart a Docker Desktop that runs but does not answer (`doctor --fix`). */
	forceRestartUnresponsive?: boolean;
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
	// Docker Desktop's processes alive with no daemon answering: still
	// starting, or hung. `open -a Docker` cannot help a hung one.
	const desktopPids =
		runtime === "docker-desktop" && !ci ? runningDockerDesktopPids() : [];
	if (desktopPids.length > 0 && !autoStart)
		throw unresponsiveDockerError(desktopPids);
	const command = waitOnly ? undefined : runtimeStartCommand(runtime);
	if (!waitOnly && (!autoStart || command === undefined))
		throw new DockerUnavailableError(runtime, remediationFor(runtime));
	if (verbose && !waitOnly)
		console.log(
			formatStep(
				desktopPids.length > 0
					? "🐳 Docker Desktop is running but not answering yet. Waiting..."
					: `🐳 Docker is not running. Starting ${runtime}...`,
			),
		);
	if (command && desktopPids.length === 0 && remainingTime(deadline) > 0)
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

	const waitUntil = async (until: number, startedAt: number) => {
		while (remainingTime(until) > 0) {
			signal?.throwIfAborted();
			if (await daemonRunning()) {
				if (verbose) console.log(formatDone("Docker is ready"));
				return true;
			}
			await abortableSleep(Math.min(1000, remainingTime(until)), signal);
			if (verbose)
				console.log(
					formatWait(
						`Waiting for Docker... (${Math.round((performance.now() - startedAt) / 1000)}s)`,
					),
				);
		}
		return false;
	};

	// The full wait first: a Desktop that is still starting answers inside it.
	if (await waitUntil(deadline, performance.now())) return;
	signal?.throwIfAborted();

	const stillRunning =
		runtime === "docker-desktop" && !ci ? runningDockerDesktopPids() : [];
	if (stillRunning.length === 0)
		throw new DockerUnavailableError(runtime, remediationFor(runtime));
	if (!options.forceRestartUnresponsive)
		throw unresponsiveDockerError(stillRunning);
	const uptimeMs = youngestUptimeMs(stillRunning);
	if (uptimeMs === undefined || !isDockerDesktopHung(uptimeMs))
		throw new DockerUnavailableError(
			"docker-desktop",
			"Give it a minute, then run `buncargo doctor --fix` again.",
			"Docker Desktop is still starting: it started too recently to be called hung.",
		);
	const upSeconds = Math.round(uptimeMs / 1000);
	const warning = `Docker Desktop (pid ${stillRunning.join(", ")}) has run for ${upSeconds}s without answering. Force-restarting it stops every container on this machine, every checkout's; volumes are kept.`;
	// Asked in a terminal; `doctor --fix` without one is the request itself.
	const confirmed =
		!isInteractive() ||
		(await askConfirm([
			`  ${warning}`,
			"",
			"  y to force-restart Docker Desktop  ·  Enter to leave it",
		]));
	if (!confirmed) throw unresponsiveDockerError(stillRunning);
	if (verbose) console.log(formatStep(`🐳 ${warning} Restarting it...`));
	await forceRestartDockerDesktop(stillRunning, signal);
	if (
		await waitUntil(performance.now() + RESTART_TIMEOUT_MS, performance.now())
	)
		return;
	signal?.throwIfAborted();
	throw new DockerUnavailableError(runtime, remediationFor(runtime));
}
