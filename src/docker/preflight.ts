import { existsSync } from "node:fs";
import { isDefined, startTimer, typedSwitch, typedSwitchGroup } from "hanzio";
import {
	ContainerRuntimeUnavailableError,
	type RuntimeAvailability,
} from "../container-runtime/types";
import { abortableSleep, remainingTime } from "../core/deadline";
import { execAsync } from "../core/process/exec";
import { askConfirm, isInteractive } from "../core/prompt";
import { isCI } from "../core/runtime-flags";
import { formatDone, formatStep, formatWait } from "../core/style";
import { lookupOnPath } from "../core/tool-binary";
import {
	DEFAULT_DOCKER_BINARY,
	type DockerRunResult,
	runDocker,
	runDockerAsync,
} from "./binary";

export type DockerRuntime =
	| "orbstack"
	| "docker-desktop"
	/** The plain engine on Linux, run by the system service manager. */
	| "docker-engine"
	| "colima"
	| "rancher"
	| "podman"
	| "unknown";

/**
 * Docker cannot be used. A `ContainerRuntimeUnavailableError` like Apple's,
 * so a caller catching that one catches both; `runtime` is `"docker"` and
 * `dockerRuntime` names what runs the daemon.
 */
export class DockerUnavailableError extends ContainerRuntimeUnavailableError {
	readonly dockerRuntime: DockerRuntime;

	constructor(
		dockerRuntime: DockerRuntime,
		remediation: string,
		problem = dockerRuntime === "unknown"
			? "Docker is not running."
			: `Docker is not running (${dockerRuntime}).`,
	) {
		super("docker", "Docker", remediation, problem);
		this.name = "DockerUnavailableError";
		this.dockerRuntime = dockerRuntime;
	}
}

/** A `PATH` scan, not a spawn: this runs while deciding how to report a failure. */
function commandExists(command: string): boolean {
	return lookupOnPath(command) !== undefined;
}

/** The runtimes a machine can have installed, in the order they are guessed. */
const INSTALLABLE_RUNTIMES = [
	"orbstack",
	"colima",
	"rancher",
	"podman",
	"docker-desktop",
] as const;
type InstallableRuntime = (typeof INSTALLABLE_RUNTIMES)[number];

/** Whether a runtime is installed here, asked of the machine itself. */
export function installedDockerRuntime(
	binary: string = DEFAULT_DOCKER_BINARY,
): (runtime: InstallableRuntime) => boolean {
	return (runtime) =>
		typedSwitch(runtime, {
			orbstack: () => existsSync("/Applications/OrbStack.app"),
			colima: () => commandExists("colima"),
			rancher: () => existsSync("/Applications/Rancher Desktop.app"),
			podman: () => commandExists("podman"),
			"docker-desktop": () =>
				existsSync("/Applications/Docker.app") || commandExists(binary),
		});
}

/**
 * Which runtime the current `docker context` talks to.
 *
 * The context names the daemon the CLI uses, so it wins over which apps are
 * installed: a Mac with OrbStack installed but `desktop-linux` selected runs
 * Docker Desktop, and guessing OrbStack opened the wrong app and skipped
 * Desktop's hang detection. Installed apps only guess for a context that
 * names nothing (`default`, or one that could not be read). On Linux that
 * context is Docker's own engine whatever else is on PATH: a CI image with
 * podman installed still runs the engine, which nothing here can or should
 * start.
 */
export function runtimeFromContext(
	context: string,
	platform: NodeJS.Platform,
	installed: (runtime: InstallableRuntime) => boolean,
): DockerRuntime {
	if (context.includes("orbstack")) return "orbstack";
	if (context.includes("colima")) return "colima";
	if (context.includes("rancher")) return "rancher";
	if (context.includes("podman")) return "podman";
	if (context.startsWith("desktop-")) return "docker-desktop";
	if (platform === "linux") return "docker-engine";
	return INSTALLABLE_RUNTIMES.find(installed) ?? "unknown";
}

/** The flavour behind this `docker`, from its context: only failure paths ask. */
function detectDockerRuntime(binary?: string): DockerRuntime {
	const context = runDocker(binary, ["context", "show"], { timeoutMs: 5000 });
	return runtimeFromContext(
		context.ok ? context.stdout.trim().toLowerCase() : "",
		process.platform,
		installedDockerRuntime(binary),
	);
}

/**
 * Docker's own words for "the daemon is not there". Its "error during
 * connect" prefixes every failure that is not a refused connection (a
 * transport timeout, a pipe this user may not open), so only a Windows pipe
 * that does not exist counts among them.
 */
function isDaemonDownMessage(message: string): boolean {
	const cannotConnect =
		/cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running/i;
	const noPipe = /error during connect:.*pipe.*cannot find the file specified/i;
	return cannotConnect.test(message) || noPipe.test(message);
}

/** What one `docker version` said about the daemon. */
export type DockerDaemonState =
	| { state: "up" }
	/** Docker's own "cannot connect", or no `docker` at all: nothing runs. */
	| { state: "down" }
	/** Up, but this user may not open its socket. */
	| { state: "denied" }
	/** Cut off at the probe's timeout: a hung daemon, or a slow one. */
	| { state: "silent" }
	/** A failure nobody has classified yet. */
	| { state: "failed"; detail: string };

/**
 * Only Docker's own "cannot connect", or no `docker` at all, reads as down:
 * the other failures may be a daemon running every container we have.
 */
export function dockerDaemonStateFrom(
	result: DockerRunResult,
): DockerDaemonState {
	if (result.ok) return { state: "up" };
	if (result.status === "notFound") return { state: "down" };
	if (result.status === "timedOut") return { state: "silent" };
	if (/permission denied/i.test(result.stderr)) return { state: "denied" };
	if (isDaemonDownMessage(result.stderr)) return { state: "down" };
	const detail =
		result.stderr.trim() || `docker version exited ${result.exitCode}`;
	return { state: "failed", detail };
}

export function dockerDaemonState(binary?: string): DockerDaemonState {
	// `info` also inspects CLI plugins, whose metadata can stall a healthy
	// daemon's probe. `version` asks the server without that extra discovery.
	return dockerDaemonStateFrom(
		runDocker(binary, ["version", "--format", "{{.Server.Version}}"]),
	);
}

export function dockerAvailability(
	daemon: DockerDaemonState,
): RuntimeAvailability {
	return typedSwitch(daemon, "state", {
		up: () => ({ state: "up" }),
		down: () => ({ state: "down" }),
		denied: () => ({
			state: "unreachable",
			detail: "this user cannot open Docker's socket",
		}),
		silent: () => ({
			state: "unreachable",
			detail: "Docker did not answer in time",
		}),
		failed: ({ detail }) => ({ state: "unreachable", detail }),
	});
}

export function isDockerDaemonRunning(binary?: string): boolean {
	return dockerDaemonState(binary).state === "up";
}

function socketPermissionError(runtime: DockerRuntime): DockerUnavailableError {
	return new DockerUnavailableError(
		runtime,
		"Add your user to the docker group (sudo usermod -aG docker $USER), then log in again or restart the service you run buncargo from: running processes keep their old groups.",
		"Docker is running, but this user cannot open its socket.",
	);
}

function dockerBinaryMissingError(
	binary = DEFAULT_DOCKER_BINARY,
): DockerUnavailableError {
	const runtime = runtimeFromContext(
		"",
		process.platform,
		installedDockerRuntime(binary),
	);
	return new DockerUnavailableError(
		runtime,
		"Install Docker, or put your runtime's `docker` on PATH (OrbStack: ~/.orbstack/bin), or point `docker.binary` in dev.config.ts at it.",
		`The Docker CLI (\`${binary}\`) was not found.`,
	);
}

/** Why Docker cannot be used and what to do, for a caller that does not wait for it. */
export function dockerUnavailableError(
	daemon: Exclude<DockerDaemonState, { state: "up" }>,
	binary?: string,
): DockerUnavailableError {
	const runtime = detectDockerRuntime(binary);
	return typedSwitch(daemon, "state", {
		down: () => new DockerUnavailableError(runtime, remediationFor(runtime)),
		denied: () => socketPermissionError(runtime),
		silent: () =>
			new DockerUnavailableError(
				runtime,
				"It may be hung; `buncargo doctor --fix` restarts a hung Docker Desktop.",
				"Docker did not answer in time.",
			),
		failed: ({ detail }) =>
			new DockerUnavailableError(
				runtime,
				"Run `docker version` to see why, then try again.",
				`Docker did not answer: ${detail}.`,
			),
	});
}

function remediationFor(runtime: DockerRuntime): string {
	return typedSwitch(runtime, {
		orbstack: () => "Start OrbStack (open -a OrbStack) and try again.",
		"docker-desktop": () =>
			"Start Docker Desktop (open -a Docker) and try again.",
		"docker-engine": () =>
			"Start the Docker service (sudo systemctl start docker) and try again.",
		colima: () => "Run `colima start` and try again.",
		rancher: () =>
			'Start Rancher Desktop (open -a "Rancher Desktop") and try again.',
		podman: () =>
			"Start the Podman machine (`podman machine start`) and try again.",
		unknown: () => "Start Docker and try again.",
	});
}

function runtimeStartCommand(runtime: DockerRuntime): string[] | undefined {
	return typedSwitch(runtime, {
		orbstack: () => ["open", "-a", "OrbStack"],
		"docker-desktop": () => ["open", "-a", "Docker"],
		colima: () => ["colima", "start"],
		rancher: () => ["open", "-a", "Rancher Desktop"],
		podman: () => ["podman", "machine", "start"],
		...typedSwitchGroup(runtime, ["docker-engine", "unknown"], () => undefined),
	});
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

/**
 * `ps` with these arguments, or undefined when it fails or cannot be spawned
 * (spawning throws when it is not on `PATH`): only failure paths ask.
 */
function readPs(args: string[]): string | undefined {
	try {
		const result = Bun.spawnSync(["ps", ...args], {
			stdout: "pipe",
			stderr: "ignore",
		});
		return result.success ? result.stdout.toString() : undefined;
	} catch {
		return undefined;
	}
}

/** Docker Desktop processes of this user still running; only asked once the daemon failed. */
function runningDockerDesktopPids(): number[] {
	const uid = process.getuid?.();
	if (process.platform !== "darwin" || uid === undefined) return [];
	const output = readPs(["-axo", "pid=,uid=,comm="]);
	return output === undefined ? [] : parseDockerDesktopPids(output, uid);
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
	const output = readPs(["-o", "etime=", "-p", pids.join(",")]);
	if (output === undefined) return undefined;
	const ages = output.split("\n").map(parseElapsed).filter(isDefined);
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
	/** Starts a daemon `runtimeStartCommand` has no command for (`docker.startCommand`). */
	startCommand?: string;
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
	// No binary to run: starting a runtime or polling cannot change that, and
	// a Mac with OrbStack installed but its `docker` off PATH would otherwise
	// open OrbStack and wait out the whole deadline.
	if (first.status === "notFound") throw dockerBinaryMissingError(binary);
	const context = await runDockerAsync(binary, ["context", "show"], {
		signal,
		timeoutMs: Math.min(5000, remainingTime(deadline)),
	});
	const runtime = runtimeFromContext(
		context.ok ? context.stdout.trim().toLowerCase() : "",
		process.platform,
		installedDockerRuntime(binary),
	);
	// A daemon that is up but refuses this user would otherwise read as "not
	// running", and the wait below could never end differently.
	if (dockerDaemonStateFrom(first).state === "denied")
		throw socketPermissionError(runtime);
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
	const command = waitOnly
		? undefined
		: (runtimeStartCommand(runtime) ??
			(options.startCommand ? ["sh", "-c", options.startCommand] : undefined));
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

	const waitUntil = async (until: number) => {
		const elapsed = startTimer();
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
						`Waiting for Docker... (${Math.round(elapsed() / 1000)}s)`,
					),
				);
		}
		return false;
	};

	// The full wait first: a Desktop that is still starting answers inside it.
	if (await waitUntil(deadline)) return;
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
	if (await waitUntil(performance.now() + RESTART_TIMEOUT_MS)) return;
	signal?.throwIfAborted();
	throw new DockerUnavailableError(runtime, remediationFor(runtime));
}
