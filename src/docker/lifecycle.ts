import { formatPortOwner, getPortOwner } from "../core/process";
import { formatDone, formatStep } from "../core/style";
import { type DockerRunResult, runDocker, runDockerAsync } from "./binary";
import { getComposeArgs } from "./compose-command";
import { isDockerDaemonRunning } from "./preflight";
import { assertDockerRunning } from "./status";

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

/**
 * Start Docker Compose containers.
 */
export function startContainers(
	root: string,
	projectName: string,
	envVars: Record<string, string>,
	options: StartContainersOptions = {},
): void {
	const {
		verbose = true,
		wait = true,
		composeFile,
		services = [],
		binary,
	} = options;
	assertDockerRunning(binary);

	if (verbose) console.log(formatStep("🐳 Starting Docker containers..."));

	const result = runDocker(
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
			timeoutMs: options.timeoutMs ?? 600000,
			env: { ...envVars, COMPOSE_PROJECT_NAME: projectName },
			inherit: verbose,
		},
	);
	if (!result.ok) translateComposeFailure(result);

	if (verbose) console.log(formatDone("Containers started"));
}

/**
 * Stop Docker Compose containers.
 */
export function stopContainers(
	root: string,
	projectName: string,
	options: StopContainersOptions = {},
): void {
	const {
		verbose = true,
		removeVolumes = false,
		composeFile,
		binary,
	} = options;
	if (!isDockerDaemonRunning(binary)) {
		if (verbose) {
			console.log(formatStep("ℹ Docker is not running. Nothing to stop."));
		}
		return;
	}

	if (verbose) {
		console.log(
			formatStep(
				removeVolumes
					? "🗑️  Stopping containers and removing volumes..."
					: "🛑 Stopping containers...",
			),
		);
	}

	const result = runDocker(
		binary,
		[
			...getComposeArgs({ projectName, composeFile }),
			"down",
			...(removeVolumes ? ["-v"] : []),
		],
		{
			cwd: root,
			timeoutMs: options.timeoutMs ?? 600000,
			env: { COMPOSE_PROJECT_NAME: projectName },
			inherit: verbose,
		},
	);
	if (!result.ok) translateComposeFailure(result);

	if (verbose) console.log(formatDone("Containers stopped"));
}

/**
 * Start a specific service only.
 */
export function startService(
	root: string,
	projectName: string,
	serviceName: string,
	envVars: Record<string, string>,
	options: { verbose?: boolean; composeFile?: string; binary?: string } = {},
): void {
	const { verbose = true, composeFile, binary } = options;
	assertDockerRunning(binary);

	if (verbose) console.log(formatStep(`🐳 Starting ${serviceName}...`));

	const result = runDocker(
		binary,
		[...getComposeArgs({ projectName, composeFile }), "up", "-d", serviceName],
		{
			cwd: root,
			env: { ...envVars, COMPOSE_PROJECT_NAME: projectName },
			inherit: verbose,
			timeoutMs: 600000,
		},
	);
	if (!result.ok) translateComposeFailure(result);
}

export async function startContainersAsync(
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

export async function stopContainersAsync(
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
	const result = await runDockerAsync(
		binary,
		[
			...getComposeArgs({ projectName, composeFile }),
			"down",
			...(removeVolumes ? ["-v"] : []),
		],
		{
			cwd: root,
			env: { COMPOSE_PROJECT_NAME: projectName },
			inherit: verbose,
			signal,
			timeoutMs,
		},
	);
	if (!result.ok) translateComposeFailure(result);
	if (verbose) console.log(formatDone("Containers stopped"));
}
