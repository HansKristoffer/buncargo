import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getComposeArg } from "../docker/compose-command";
import { simpleHash } from "./hash";
import { isProcessAlive } from "./process";
import { formatDone, formatWarn } from "./style";
import {
	WATCHDOG_DEFAULT_TIMEOUT_MINUTES,
	WATCHDOG_HEARTBEAT_INTERVAL_MS,
} from "./watchdog-constants";

export interface HeartbeatPayload {
	ts: number;
	pid: number;
}

function namespaceId(projectName: string, root?: string): string {
	if (!root) return projectName;
	const hash = simpleHash(root).toString(16).slice(0, 8);
	return `${projectName}-${hash}`;
}

export function getHeartbeatFile(projectName: string, root?: string): string {
	return `/tmp/${namespaceId(projectName, root)}-heartbeat`;
}

export function getWatchdogPidFile(projectName: string, root?: string): string {
	return `/tmp/${namespaceId(projectName, root)}-watchdog.pid`;
}

export function getWatchdogLogFile(projectName: string, root?: string): string {
	return `/tmp/${namespaceId(projectName, root)}-watchdog.log`;
}

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatProject: { projectName: string; root?: string } | null = null;

export function writeHeartbeatPayload(
	projectName: string,
	root?: string,
	payload: HeartbeatPayload = { ts: Date.now(), pid: process.pid },
): void {
	writeFileSync(getHeartbeatFile(projectName, root), JSON.stringify(payload));
}

export function startHeartbeat(
	projectName: string,
	intervalMs = WATCHDOG_HEARTBEAT_INTERVAL_MS,
	root?: string,
): void {
	heartbeatProject = { projectName, root };
	writeHeartbeatPayload(projectName, root);
	heartbeatInterval = setInterval(() => {
		writeHeartbeatPayload(projectName, root);
	}, intervalMs);
}

export function stopHeartbeat(): void {
	if (heartbeatInterval) {
		clearInterval(heartbeatInterval);
		heartbeatInterval = null;
	}
	if (heartbeatProject) {
		removeHeartbeatFile(heartbeatProject.projectName, heartbeatProject.root);
		heartbeatProject = null;
	}
}

export function parseHeartbeatPayload(
	content: string,
): HeartbeatPayload | null {
	const trimmed = content.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as Partial<HeartbeatPayload> | number;
		if (typeof parsed === "number" && Number.isFinite(parsed)) {
			return { ts: parsed, pid: 0 };
		}
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof parsed.ts === "number" &&
			Number.isFinite(parsed.ts) &&
			typeof parsed.pid === "number"
		) {
			return { ts: parsed.ts, pid: parsed.pid };
		}
	} catch {
		const timestamp = Number.parseInt(trimmed, 10);
		if (!Number.isNaN(timestamp)) {
			return { ts: timestamp, pid: 0 };
		}
	}
	return null;
}

export function readHeartbeatPayload(
	projectName: string,
	root?: string,
): HeartbeatPayload | null {
	const heartbeatFile = getHeartbeatFile(projectName, root);
	try {
		if (!existsSync(heartbeatFile)) return null;
		return parseHeartbeatPayload(readFileSync(heartbeatFile, "utf-8"));
	} catch {
		return null;
	}
}

export function readHeartbeat(
	projectName: string,
	root?: string,
): number | null {
	return readHeartbeatPayload(projectName, root)?.ts ?? null;
}

export function removeHeartbeatFile(projectName: string, root?: string): void {
	try {
		unlinkSync(getHeartbeatFile(projectName, root));
	} catch {
		// File may not exist
	}
}

export function isWatchdogRunning(projectName: string, root?: string): boolean {
	return getWatchdogPid(projectName, root) !== null;
}

export function getWatchdogPid(
	projectName: string,
	root?: string,
): number | null {
	const pidFile = getWatchdogPidFile(projectName, root);
	try {
		if (!existsSync(pidFile)) return null;
		const pid = Number.parseInt(readFileSync(pidFile, "utf-8"), 10);
		if (Number.isNaN(pid)) return null;
		if (!isProcessAlive(pid)) return null;
		return pid;
	} catch {
		return null;
	}
}

export function getWatchdogComposeArg(composeFile?: string): string {
	return getComposeArg(composeFile);
}

export function resolveWatchdogRunnerPath(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(moduleDir, "watchdog-runner.js"),
		join(moduleDir, "watchdog-runner.ts"),
		join(moduleDir, "core", "watchdog-runner.js"),
		join(moduleDir, "core", "watchdog-runner.ts"),
	];
	let dir = moduleDir;
	for (let i = 0; i < 6; i++) {
		candidates.push(join(dir, "dist/core/watchdog-runner.js"));
		candidates.push(join(dir, "src/core/watchdog-runner.ts"));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(
		"Watchdog runner not found. Rebuild buncargo so dist/core/watchdog-runner.js is emitted.",
	);
}

export async function spawnWatchdog(
	projectName: string,
	root: string,
	options: {
		timeoutMinutes?: number;
		verbose?: boolean;
		composeFile?: string;
	} = {},
): Promise<void> {
	const {
		timeoutMinutes = WATCHDOG_DEFAULT_TIMEOUT_MINUTES,
		verbose = true,
		composeFile,
	} = options;

	const existingPid = getWatchdogPid(projectName, root);
	if (existingPid) {
		return;
	}

	const pidFile = getWatchdogPidFile(projectName, root);
	try {
		unlinkSync(pidFile);
	} catch {
		// File may not exist
	}

	const watchdogScript = resolveWatchdogRunnerPath();
	const logFile = getWatchdogLogFile(projectName, root);
	writeFileSync(logFile, "");

	const proc = spawn("bun", ["run", watchdogScript], {
		cwd: root,
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
		env: {
			...process.env,
			WATCHDOG_PROJECT_NAME: projectName,
			WATCHDOG_ROOT: root,
			WATCHDOG_HEARTBEAT_FILE: getHeartbeatFile(projectName, root),
			WATCHDOG_PID_FILE: pidFile,
			WATCHDOG_LOG_FILE: logFile,
			WATCHDOG_TIMEOUT_MS: String(timeoutMinutes * 60 * 1000),
			WATCHDOG_COMPOSE_ARG: getWatchdogComposeArg(composeFile),
		},
	});

	proc.unref();

	const startedAt = Date.now();
	while (Date.now() - startedAt < 2000) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (existsSync(pidFile) && getWatchdogPid(projectName, root)) {
			if (verbose && proc.pid) {
				console.log(formatDone(`Watchdog started (PID: ${proc.pid})`));
			}
			return;
		}
	}

	if (verbose) {
		console.warn(
			formatWarn(
				`Watchdog did not start. Check ${logFile} and rebuild buncargo if dist/core/watchdog-runner.js is missing.`,
			),
		);
	}
}

export function stopWatchdog(projectName: string, root?: string): void {
	const pid = getWatchdogPid(projectName, root);
	if (pid) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Process may already be dead
		}
	}

	try {
		unlinkSync(getWatchdogPidFile(projectName, root));
	} catch {
		// File may not exist
	}
}
