import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContainerRuntimeName } from "../types";
import { withFileLock } from "./file-lock";
import { simpleHash } from "./hash";
import { isProcessAlive } from "./process/lifecycle";
import {
	matchesProcessIdentity,
	readProcessIdentity,
} from "./process-identity";
import { writeJsonDocumentSync } from "./registry-file";
import { formatDone, formatWarn } from "./style";
import {
	WATCHDOG_DEFAULT_TIMEOUT_MINUTES,
	WATCHDOG_HEARTBEAT_INTERVAL_MS,
} from "./watchdog-constants";

export interface HeartbeatPayload {
	ts: number;
	pid: number;
	ownerId?: string;
	processIdentity?: string;
	/**
	 * The owner exited on purpose and may come straight back.
	 *
	 * Deleting the file instead made a deliberate Ctrl-C indistinguishable from
	 * a crash, so the watchdog tore the stack down inside the short crash grace
	 * and every restart paid for a container recreate.
	 */
	released?: boolean;
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

export function getHeartbeatOwnersDir(
	projectName: string,
	root?: string,
): string {
	return `${getHeartbeatFile(projectName, root)}.owners`;
}

export interface HeartbeatOwner {
	start(intervalMs?: number): void;
	stop(): void;
}

/** An environment owns its own timer and marker, even beside another in-process environment. */
export function createHeartbeatOwner(
	projectName: string,
	root?: string,
): HeartbeatOwner {
	let ownerId = "";
	let path = "";
	let timer: ReturnType<typeof setInterval> | undefined;
	let processIdentity: string | undefined;
	const publish = (released = false) => {
		const payload: HeartbeatPayload = {
			ts: Date.now(),
			pid: released ? 0 : process.pid,
			ownerId,
			...(released ? { released: true } : { processIdentity }),
		};
		writeJsonDocumentSync(path, payload);
		// Retain the legacy snapshot for older readers. Current watchdogs read
		// every independent owner, so one exiting session cannot hide another.
		writeHeartbeatPayload(projectName, root, payload);
	};
	return {
		start(intervalMs = WATCHDOG_HEARTBEAT_INTERVAL_MS) {
			if (timer) return;
			if (!Number.isFinite(intervalMs) || intervalMs <= 0)
				throw new Error("Heartbeat interval must be positive");
			ownerId = randomUUID();
			path = join(getHeartbeatOwnersDir(projectName, root), `${ownerId}.json`);
			processIdentity = readProcessIdentity(process.pid);
			publish();
			pruneOldHeartbeatOwners(projectName, root);
			timer = setInterval(() => {
				try {
					publish();
				} catch {
					/* Retry next tick; a write failure must not crash an app. */
				}
			}, intervalMs);
			timer.unref();
		},
		stop() {
			if (!timer) return;
			clearInterval(timer);
			timer = undefined;
			try {
				const current = parseHeartbeatPayload(readFileSync(path, "utf8"));
				if (current?.ownerId === ownerId && current.pid === process.pid)
					publish(true);
			} catch {
				/* Leave existing state for the watchdog's retry. */
			}
		},
	};
}

/** Each start gets an immutable owner name, so retired markers cannot come back. */
function pruneOldHeartbeatOwners(projectName: string, root?: string): void {
	const directory = getHeartbeatOwnersDir(projectName, root);
	try {
		for (const name of readdirSync(directory)) {
			if (!name.endsWith(".json")) continue;
			const path = join(directory, name);
			const payload = parseHeartbeatPayload(readFileSync(path, "utf8"));
			if (
				payload &&
				Date.now() - payload.ts > 24 * 60 * 60 * 1000 &&
				!isHeartbeatOwnerAlive(payload)
			)
				unlinkSync(path);
		}
	} catch {
		/* Retention is best-effort; active owners remain authoritative. */
	}
}

const legacyHeartbeatOwners = new Map<string, HeartbeatOwner>();

export function writeHeartbeatPayload(
	projectName: string,
	root?: string,
	payload: HeartbeatPayload = { ts: Date.now(), pid: process.pid },
): void {
	writeJsonDocumentSync(getHeartbeatFile(projectName, root), payload);
}

/** Compatibility entry point, idempotent per project. Environment instances use createHeartbeatOwner. */
export function startHeartbeat(
	projectName: string,
	intervalMs = WATCHDOG_HEARTBEAT_INTERVAL_MS,
	root?: string,
): HeartbeatOwner {
	const key = getHeartbeatFile(projectName, root);
	let owner = legacyHeartbeatOwners.get(key);
	if (!owner) {
		owner = createHeartbeatOwner(projectName, root);
		legacyHeartbeatOwners.set(key, owner);
	}
	owner.start(intervalMs);
	return owner;
}

/** Stop a specific owner, or the legacy entry points started in this process. */
export function stopHeartbeat(
	owner?: HeartbeatOwner | string,
	root?: string,
): void {
	if (typeof owner === "string") {
		const key = getHeartbeatFile(owner, root);
		legacyHeartbeatOwners.get(key)?.stop();
		legacyHeartbeatOwners.delete(key);
		return;
	}
	if (owner) {
		owner.stop();
		return;
	}
	for (const entry of legacyHeartbeatOwners.values()) entry.stop();
	legacyHeartbeatOwners.clear();
}

/** Startup/reconciliation and delayed teardown use the same exclusion gate. */
export function withWatchdogProjectLock<T>(
	projectName: string,
	root: string,
	operation: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return withFileLock(
		`${getHeartbeatFile(projectName, root)}.lifecycle`,
		operation,
		{ timeoutMs: 120_000, signal },
	);
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
			typeof parsed.pid === "number" &&
			Number.isInteger(parsed.pid) &&
			parsed.pid >= 0
		) {
			return {
				ts: parsed.ts,
				pid: parsed.pid,
				...(typeof parsed.ownerId === "string"
					? { ownerId: parsed.ownerId }
					: {}),
				...(typeof parsed.processIdentity === "string"
					? { processIdentity: parsed.processIdentity }
					: {}),
				...(parsed.released === true ? { released: true } : {}),
			};
		}
	} catch {
		const timestamp = Number.parseInt(trimmed, 10);
		if (!Number.isNaN(timestamp)) {
			return { ts: timestamp, pid: 0 };
		}
	}
	return null;
}

export function isHeartbeatOwnerAlive(owner: HeartbeatPayload): boolean {
	if (owner.released || owner.pid <= 1 || !isProcessAlive(owner.pid))
		return false;
	if (!owner.processIdentity) return true;
	const actual = readProcessIdentity(owner.pid);
	// An inability to inspect birth identity must not tear down a live stack.
	return actual === undefined || actual === owner.processIdentity;
}

export function readHeartbeatPayload(
	projectName: string,
	root?: string,
): HeartbeatPayload | null {
	const heartbeatFile = getHeartbeatFile(projectName, root);
	try {
		const directory = getHeartbeatOwnersDir(projectName, root);
		if (existsSync(directory)) {
			const owners = readdirSync(directory)
				.filter((name) => name.endsWith(".json"))
				.map((name) =>
					parseHeartbeatPayload(readFileSync(join(directory, name), "utf8")),
				);
			const valid = owners
				.filter((owner): owner is HeartbeatPayload => owner !== null)
				.sort((a, b) => b.ts - a.ts);
			const alive = valid.find((owner) => isHeartbeatOwnerAlive(owner));
			if (alive) return alive;
			if (owners.some((owner) => owner === null)) return null;
			if (valid[0]) return valid[0];
		}
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
		rmSync(getHeartbeatOwnersDir(projectName, root), {
			recursive: true,
			force: true,
		});
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
		const raw = readFileSync(pidFile, "utf-8");
		if (raw.trim().startsWith("{")) {
			const owner = JSON.parse(raw) as {
				pid?: unknown;
				processIdentity?: unknown;
			};
			if (typeof owner.pid !== "number") return null;
			return matchesProcessIdentity(
				owner.pid,
				typeof owner.processIdentity === "string"
					? owner.processIdentity
					: undefined,
			)
				? owner.pid
				: null;
		}
		const pid = Number.parseInt(raw, 10);
		return Number.isInteger(pid) && pid > 1 && isProcessAlive(pid) ? pid : null;
	} catch {
		return null;
	}
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
		containerRuntime?: ContainerRuntimeName;
		/** Path the runtime is executed as, when the project pinned one. */
		containerRuntimeBinary?: string;
	} = {},
): Promise<void> {
	const {
		timeoutMinutes = WATCHDOG_DEFAULT_TIMEOUT_MINUTES,
		verbose = true,
		composeFile,
		containerRuntime = "docker",
		containerRuntimeBinary,
	} = options;

	await withFileLock(
		`${getWatchdogPidFile(projectName, root)}.spawn`,
		async () => {
			const existingPid = getWatchdogPid(projectName, root);
			if (existingPid) {
				return;
			}

			const pidFile = getWatchdogPidFile(projectName, root);

			const watchdogScript = resolveWatchdogRunnerPath();
			const logFile = getWatchdogLogFile(projectName, root);
			writeFileSync(logFile, "");

			const proc = spawn(process.execPath, [watchdogScript], {
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
					WATCHDOG_COMPOSE_FILE: composeFile ?? "",
					WATCHDOG_CONTAINER_RUNTIME: containerRuntime,
					// Without this a project pinning `docker.binary` would tear down
					// through whatever happens to be on the detached process's PATH.
					WATCHDOG_CONTAINER_BINARY: containerRuntimeBinary ?? "",
				},
			});

			let spawnError: Error | undefined;
			proc.on("error", (error) => {
				spawnError = error;
			});
			proc.unref();

			const startedAt = Date.now();
			while (Date.now() - startedAt < 2000) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				if (spawnError) throw spawnError;
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
		},
	);
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

	// The runner removes only its own pid record after receiving the signal.
}
