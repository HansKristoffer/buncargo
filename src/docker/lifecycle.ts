import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { formatPortOwner, getPortOwner } from "../core/process";
import { formatDone, formatStep, formatWarn } from "../core/style";
import { type DockerRunResult, runDockerAsync } from "./binary";
import { getComposeArgs } from "./compose-command";
import { isDockerDaemonRunning } from "./preflight";

export interface StartContainersOptions {
	noDeps?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
	verbose?: boolean;
	wait?: boolean;
	composeFile?: string;
	services?: string[];
	binary?: string;
}

export interface StopContainersOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	verbose?: boolean;
	removeVolumes?: boolean;
	composeFile?: string;
	binary?: string;
}

/** Compose's own words for "the daemon is not there". */
function isDaemonDownMessage(message: string): boolean {
	return /cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running|error during connect/i.test(
		message,
	);
}

/**
 * The Docker CLI's words when it has no Compose plugin to hand.
 *
 * Docker Desktop installs Compose under `~/.docker/cli-plugins`, found through
 * `HOME`, so a process started with a different `HOME` has Docker but not
 * Compose. Every teardown then fails the same way, and a raw "not a docker
 * command" says nothing about why.
 */
function isComposeMissingMessage(message: string): boolean {
	return /'compose' is not a docker command/i.test(message);
}

const COMPOSE_MISSING =
	"Docker Compose is not available to this process. Docker Desktop provides it through ~/.docker/cli-plugins, which is found through HOME; run buncargo with your usual HOME, or install the compose plugin system-wide.";

/**
 * Turn compose's "port is already allocated" into a message naming the owner.
 *
 * Only reachable with a captured stderr, which means the quiet path; a verbose
 * run streamed compose's own output to the terminal already.
 */
function translateComposeFailure(result: DockerRunResult): never {
	const message = result.stderr.trim();
	const allocated =
		message.match(/Bind for .+:(\d+) failed: port is already allocated/i) ??
		message.match(/address already in use/i);
	const portMatch = message.match(/:(\d{2,5})/);
	if (allocated && portMatch?.[1]) {
		const port = Number.parseInt(portMatch[1], 10);
		const owner = getPortOwner(port);
		throw new Error(formatPortOwner(port, owner ?? { pids: [] }));
	}
	throw new Error(
		message || `docker compose exited with code ${result.exitCode}`,
	);
}

/** Start Docker Compose containers. */
export async function startContainers(
	root: string,
	projectName: string,
	envVars: Record<string, string>,
	options: StartContainersOptions = {},
): Promise<void> {
	const {
		verbose = true,
		wait = true,
		composeFile,
		services = [],
		binary,
		signal,
		timeoutMs = 600000,
	} = options;
	if (verbose) console.log(formatStep("🐳 Starting Docker containers..."));
	const result = await runDockerAsync(
		binary,
		[
			...getComposeArgs({ projectName, composeFile }),
			"up",
			"-d",
			...(wait ? ["--wait"] : []),
			...(options.noDeps ? ["--no-deps"] : []),
			...services,
		],
		{
			cwd: root,
			env: { ...envVars, COMPOSE_PROJECT_NAME: projectName },
			inherit: verbose,
			signal,
			timeoutMs,
		},
	);
	if (!result.ok) translateComposeFailure(result);
	if (verbose) console.log(formatDone("Containers started"));
}

/**
 * Stop and remove Docker Compose containers.
 *
 * Compose finds them by the project label, so the compose file is only needed
 * to name the volumes `removeVolumes` deletes, and the checkout only to host
 * that file. A stack whose worktree was deleted must still come down, which is
 * why neither is required here.
 */
export async function stopContainers(
	root: string,
	projectName: string,
	options: StopContainersOptions = {},
): Promise<void> {
	const {
		verbose = true,
		removeVolumes = false,
		composeFile,
		binary,
		signal,
		timeoutMs = 120000,
	} = options;
	if (verbose) console.log(formatStep("🛑 Stopping containers..."));

	const file = composeFile && existsSync(composeFile) ? composeFile : undefined;
	if (removeVolumes && !file) {
		console.warn(
			formatWarn(
				"No compose file to name the volumes; containers were removed and volumes left in place.",
			),
		);
	}
	const result = await runDockerAsync(
		binary,
		[
			...getComposeArgs({ projectName, composeFile: file }),
			"down",
			...(removeVolumes && file ? ["-v"] : []),
		],
		{
			cwd: existsSync(root) ? root : homedir(),
			env: { COMPOSE_PROJECT_NAME: projectName },
			inherit: verbose,
			signal,
			timeoutMs,
		},
	);
	if (!result.ok) {
		// A daemon that is not there has already stopped everything. Probing it
		// up front cost a `docker info` on every teardown, including each one
		// the watchdog performs; compose's own failure says the same thing.
		// A verbose run streamed that failure to the terminal instead of
		// capturing it, so only then is the probe worth its fork.
		const daemonDown = result.stderr.trim()
			? isDaemonDownMessage(result.stderr)
			: !isDockerDaemonRunning(binary);
		if (daemonDown) {
			if (verbose)
				console.log(formatStep("ℹ Docker is not running. Nothing to stop."));
			return;
		}
		if (isComposeMissingMessage(result.stderr))
			throw new Error(COMPOSE_MISSING);
		translateComposeFailure(result);
	}
	if (verbose) console.log(formatDone("Containers stopped"));
}
