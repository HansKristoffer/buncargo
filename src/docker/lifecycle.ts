import { execSync } from "node:child_process";
import { formatPortOwner, getPortOwner } from "../core/process";
import { getComposeArg } from "./compose-command";
import { isDockerDaemonRunning } from "./preflight";
import { assertDockerRunning } from "./status";

export interface StartContainersOptions {
	verbose?: boolean;
	wait?: boolean;
	composeFile?: string;
	services?: string[];
}

export interface StopContainersOptions {
	verbose?: boolean;
	removeVolumes?: boolean;
	composeFile?: string;
}

/**
 * Turn compose's "port is already allocated" into a message naming the owner.
 */
function translateComposePortError(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	const allocated =
		message.match(/Bind for .+:(\d+) failed: port is already allocated/i) ??
		message.match(/address already in use/i);
	const portMatch = message.match(/:(\d{2,5})/);
	if (allocated && portMatch?.[1]) {
		const port = Number.parseInt(portMatch[1], 10);
		const owner = getPortOwner(port);
		throw new Error(formatPortOwner(port, owner ?? { pids: [] }));
	}
	if (error instanceof Error) {
		throw error;
	}
	throw new Error(message);
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
	const { verbose = true, wait = true, composeFile, services = [] } = options;
	assertDockerRunning();

	if (verbose) console.log("🐳 Starting Docker containers...");

	const composeArg = getComposeArg(composeFile);
	const waitFlag = wait ? "--wait" : "";
	const servicesArg = services.join(" ");
	const cmd =
		`docker compose ${composeArg} up -d ${waitFlag} ${servicesArg}`.trim();

	try {
		execSync(cmd, {
			cwd: root,
			env: { ...process.env, ...envVars, COMPOSE_PROJECT_NAME: projectName },
			stdio: verbose ? "inherit" : "pipe",
		});
	} catch (error) {
		translateComposePortError(error);
	}

	if (verbose) console.log("✓ Containers started");
}

/**
 * Stop Docker Compose containers.
 */
export function stopContainers(
	root: string,
	projectName: string,
	options: StopContainersOptions = {},
): void {
	const { verbose = true, removeVolumes = false, composeFile } = options;
	if (!isDockerDaemonRunning()) {
		if (verbose) {
			console.log("ℹ Docker is not running. Nothing to stop.");
		}
		return;
	}

	if (verbose) {
		console.log(
			removeVolumes
				? "🗑️  Stopping containers and removing volumes..."
				: "🛑 Stopping containers...",
		);
	}

	const composeArg = getComposeArg(composeFile);
	const volumeFlag = removeVolumes ? "-v" : "";
	const cmd = `docker compose ${composeArg} down ${volumeFlag}`.trim();

	execSync(cmd, {
		cwd: root,
		env: { ...process.env, COMPOSE_PROJECT_NAME: projectName },
		stdio: verbose ? "inherit" : "ignore",
	});

	if (verbose) console.log("✓ Containers stopped");
}

/**
 * Start a specific service only.
 */
export function startService(
	root: string,
	projectName: string,
	serviceName: string,
	envVars: Record<string, string>,
	options: { verbose?: boolean; composeFile?: string } = {},
): void {
	const { verbose = true, composeFile } = options;
	assertDockerRunning();

	if (verbose) console.log(`🐳 Starting ${serviceName}...`);

	const composeArg = getComposeArg(composeFile);
	const cmd = `docker compose ${composeArg} up -d ${serviceName}`.trim();

	execSync(cmd, {
		cwd: root,
		env: { ...process.env, ...envVars, COMPOSE_PROJECT_NAME: projectName },
		stdio: verbose ? "inherit" : "ignore",
	});
}
