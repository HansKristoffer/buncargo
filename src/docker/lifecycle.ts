import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createPortOwnerSnapshotAsync, formatPortOwner } from "../core/process";
import { formatDone, formatStep } from "../core/style";
import { dockerRuntimeAdapter } from "./adapter";
import { type DockerRunResult, runDockerAsync } from "./binary";
import { getComposeArgs } from "./compose-command";
import {
	type DockerDaemonState,
	dockerDaemonState,
	dockerDaemonStateFrom,
	dockerUnavailableError,
} from "./preflight";
import { removeDockerVolumes } from "./volumes";

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

/**
 * The Docker CLI's words when it has no Compose plugin to hand.
 *
 * Docker Desktop installs Compose under `~/.docker/cli-plugins`, found through
 * `HOME`, so a process started with a different `HOME` has Docker but not
 * Compose. Every `up` and teardown then fails the same way, and a raw "not a docker
 * command" says nothing about why.
 */
function isComposeMissingMessage(message: string): boolean {
	return /'compose' is not a docker command/i.test(message);
}

const COMPOSE_MISSING =
	"Docker Compose is not available to this process. Docker Desktop provides it through ~/.docker/cli-plugins, which is found through HOME; run buncargo with your usual HOME, or install the compose plugin system-wide.";

/**
 * Turn compose's failure into one that says what to do: a missing Compose
 * plugin, or "port is already allocated" naming the owner.
 *
 * Only reachable with a captured stderr, which means the quiet path; a verbose
 * run streamed compose's own output to the terminal already.
 */
async function translateComposeFailure(
	result: DockerRunResult,
	binary: string | undefined,
): Promise<never> {
	const message = result.stderr.trim();
	if (isComposeMissingMessage(message)) throw new Error(COMPOSE_MISSING);
	const allocated =
		message.match(/Bind for .+:(\d+) failed: port is already allocated/i) ??
		message.match(/address already in use/i);
	const portMatch = message.match(/:(\d{2,5})/);
	if (allocated && portMatch?.[1]) {
		const port = Number.parseInt(portMatch[1], 10);
		// Asked of the same `docker` that failed, so a pinned binary's container
		// is found rather than one on whatever `docker` PATH names.
		const owners = await createPortOwnerSnapshotAsync({
			runtime: dockerRuntimeAdapter({ binary }),
			ports: [port],
		});
		throw new Error(formatPortOwner(port, owners.owner(port) ?? { pids: [] }));
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
	if (!result.ok) await translateComposeFailure(result, binary);
	if (verbose) console.log(formatDone("Containers started"));
}

/**
 * What a failed teardown said about the daemon. A failure nobody has
 * classified came from a daemon that answered, so it reads as up and the
 * teardown's own failure is reported.
 */
function daemonStateFromTeardown(result: DockerRunResult): DockerDaemonState {
	// A binary that is not there never reached the daemon, so it cannot say
	// nothing runs: the containers another binary listed may still be up.
	if (result.status === "notFound") return { state: "up" };
	const said = dockerDaemonStateFrom(result);
	return said.state === "failed" ? { state: "up" } : said;
}

/**
 * Stop and remove Docker Compose containers.
 *
 * Compose finds them by the project label, so the compose file only names
 * the volumes `removeVolumes` deletes, and the checkout only hosts that file. A stack whose worktree was deleted must still come down, which is
 * why neither is required here; `removeVolumes` without the file finds the
 * volumes by Compose's project label instead.
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

	// `composeFile` is relative to the checkout, as compose reads it from
	// `cwd: root` below; the caller's own cwd can be anywhere (an E2E runner
	// that changed into a package kept every volume it meant to reset).
	const composePath = composeFile ? resolve(root, composeFile) : undefined;
	const file = composePath && existsSync(composePath) ? composeFile : undefined;
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
		// Only a daemon that is really down has nothing running: one that
		// refuses this user or does not answer may hold every container.
		const captured = result.stderr.trim() !== "" || result.status !== "exit";
		const daemon = captured
			? daemonStateFromTeardown(result)
			: dockerDaemonState(binary);
		if (daemon.state !== "up" && daemon.state !== "down") {
			const unavailable = dockerUnavailableError(daemon, binary).message;
			const message = `Could not stop ${projectName}'s containers. ${unavailable}`;
			throw new Error(message);
		}
		if (daemon.state === "down") {
			// A reset that silently kept the volumes would not be one.
			const keptVolumes = `Docker is not running, so the volumes of ${projectName} were not removed. Start Docker, then run again.`;
			if (removeVolumes) throw new Error(keptVolumes);
			if (verbose)
				console.log(formatStep("ℹ Docker is not running. Nothing to stop."));
			return;
		}
		await translateComposeFailure(result, binary);
	}

	// A reset that kept the database is not one: the next run reads stale data.
	// Without the file, Compose's own project label names the volumes: an exact
	// match, so another project's volumes are never among them.
	if (removeVolumes && !file) {
		const listed = await runDockerAsync(
			binary,
			[
				"volume",
				"ls",
				"-q",
				"--filter",
				`label=com.docker.compose.project=${projectName}`,
			],
			{ signal, timeoutMs: 30_000 },
		);
		if (!listed.ok)
			throw new Error(
				`Removed ${projectName}'s containers but could not list its volumes: ${listed.stderr.trim() || `docker volume ls exited ${listed.exitCode}`}`,
			);
		const names = listed.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const kept = await removeDockerVolumes(names, binary);
		if (kept.length > 0)
			throw new Error(
				`Removed ${projectName}'s containers but kept these volumes: ${kept.map(({ name, error }) => `${name} (${error})`).join(", ")}`,
			);
	}
	if (verbose) console.log(formatDone("Containers stopped"));
}
