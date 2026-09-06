/**
 * Watchdog Runner
 *
 * Monitors heartbeat file and shuts down containers after the owner dies
 * or after the idle backstop (only when the owner is also gone).
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import {
	getContainerRuntimeAdapter,
	isContainerRuntimeName,
} from "../container-runtime";
import { withFileLock } from "./file-lock";
import { readProcessIdentity } from "./process-identity";
import { writeJsonDocumentSync } from "./registry-file";
import {
	getHeartbeatOwnersDir,
	getWatchdogPid,
	isHeartbeatOwnerAlive,
	readHeartbeatPayload,
	withWatchdogProjectLock,
} from "./watchdog";
import {
	WATCHDOG_IDLE_TIMEOUT_MS,
	WATCHDOG_OWNER_DEAD_GRACE_MS,
	WATCHDOG_POLL_INTERVAL_MS,
	WATCHDOG_SLEEP_JUMP_MS,
} from "./watchdog-constants";
import {
	evaluateWatchdogTick,
	type HeartbeatReading,
	type WatchdogMemory,
} from "./watchdog-decision";

const PROJECT_NAME = process.env.WATCHDOG_PROJECT_NAME ?? "";
const HEARTBEAT_FILE = process.env.WATCHDOG_HEARTBEAT_FILE ?? "";
const PID_FILE = process.env.WATCHDOG_PID_FILE ?? "";
const LOG_FILE = process.env.WATCHDOG_LOG_FILE ?? "";
const IDLE_TIMEOUT = Number.parseInt(
	process.env.WATCHDOG_TIMEOUT_MS ?? String(WATCHDOG_IDLE_TIMEOUT_MS),
	10,
);
const COMPOSE_FILE = process.env.WATCHDOG_COMPOSE_FILE ?? "";
const RUNTIME_NAME = process.env.WATCHDOG_CONTAINER_RUNTIME ?? "docker";
const RUNTIME_BINARY = process.env.WATCHDOG_CONTAINER_BINARY || undefined;
const ROOT = process.env.WATCHDOG_ROOT ?? process.cwd();

if (!PROJECT_NAME || !HEARTBEAT_FILE || !PID_FILE) {
	console.error("[watchdog] Missing required environment variables");
	process.exit(1);
}

const heartbeatFile: string = HEARTBEAT_FILE;
const pidFile: string = PID_FILE;

function log(message: string): void {
	const line = `[watchdog] ${message}`;
	console.log(line);
	if (LOG_FILE) {
		try {
			appendFileSync(LOG_FILE, `${line}\n`);
		} catch {
			// ignore log write failures
		}
	}
}

const ownerId = randomUUID();

function cleanup(): void {
	try {
		const owner = JSON.parse(readFileSync(pidFile, "utf8"));
		if (owner.ownerId === ownerId && owner.pid === process.pid)
			unlinkSync(pidFile);
	} catch {
		/* Missing or replaced: not ours to remove. */
	}
	// Heartbeats belong to their runs. A replacement may have claimed one
	// while this runner was stopping, so never remove them here.
}

async function shutdownContainers(): Promise<void> {
	const runtime = getContainerRuntimeAdapter(
		isContainerRuntimeName(RUNTIME_NAME) ? RUNTIME_NAME : "docker",
		{ binary: RUNTIME_BINARY },
	);
	const request = {
		root: ROOT,
		projectName: PROJECT_NAME,
		composeFile: COMPOSE_FILE || undefined,
		verbose: false,
	};
	if (runtime.downAsync) await runtime.downAsync(request);
	else runtime.down(request);
}

process.on("SIGTERM", () => {
	cleanup();
	process.exit(0);
});

process.on("SIGINT", () => {
	cleanup();
	process.exit(0);
});

/** Read the heartbeat, distinguishing "gone" from "cannot be parsed". */
function readHeartbeat(): HeartbeatReading {
	if (
		!existsSync(heartbeatFile) &&
		!existsSync(getHeartbeatOwnersDir(PROJECT_NAME, ROOT))
	) {
		return { status: "missing" };
	}
	try {
		const payload = readHeartbeatPayload(PROJECT_NAME, ROOT);
		return payload ? { status: "ok", payload } : { status: "unreadable" };
	} catch {
		return { status: "unreadable" };
	}
}

async function watchdog(): Promise<void> {
	let lastPoll = Date.now();
	let memory: WatchdogMemory = { ownerDeadSince: null };

	while (true) {
		await new Promise((resolve) =>
			setTimeout(resolve, WATCHDOG_POLL_INTERVAL_MS),
		);
		const now = Date.now();
		if (now - lastPoll > WATCHDOG_SLEEP_JUMP_MS) {
			memory = { ownerDeadSince: null };
			log("Detected clock jump (likely sleep); resetting idle clock");
		}
		lastPoll = now;

		const reading = readHeartbeat();
		const ownerAlive =
			reading.status === "ok" && isHeartbeatOwnerAlive(reading.payload);

		const { verdict, memory: nextMemory } = evaluateWatchdogTick(
			{ now, reading, ownerAlive },
			memory,
			{
				idleTimeoutMs: IDLE_TIMEOUT,
				ownerDeadGraceMs: WATCHDOG_OWNER_DEAD_GRACE_MS,
			},
		);
		memory = nextMemory;

		if (verdict.kind === "shutdown") {
			const stopped = await withWatchdogProjectLock(
				PROJECT_NAME,
				ROOT,
				async () => {
					// A new run can register while this watchdog is delayed on the gate.
					// Re-evaluate its actual owner immediately before issuing down.
					const latest = readHeartbeat();
					const alive =
						latest.status === "ok" && isHeartbeatOwnerAlive(latest.payload);
					const checked = evaluateWatchdogTick(
						{ now: Date.now(), reading: latest, ownerAlive: alive },
						memory,
						{
							idleTimeoutMs: IDLE_TIMEOUT,
							ownerDeadGraceMs: WATCHDOG_OWNER_DEAD_GRACE_MS,
						},
					);
					memory = checked.memory;
					if (checked.verdict.kind !== "shutdown") return false;
					log(`${checked.verdict.reason}, shutting down...`);
					await shutdownContainers();
					log("Containers stopped");
					return true;
				},
			);
			if (stopped) return;
		}
	}
}

// A descriptor held for the runner's lifetime is an atomic startup claim and
// is automatically released after crashes; a PID file alone cannot provide it.
withFileLock(
	`${pidFile}.runner`,
	async () => {
		const previous = getWatchdogPid(PROJECT_NAME, ROOT);
		if (previous && previous !== process.pid) return;
		writeJsonDocumentSync(pidFile, {
			pid: process.pid,
			ownerId,
			processIdentity: readProcessIdentity(process.pid),
		});
		log(`Started for ${PROJECT_NAME} (PID: ${process.pid})`);
		log(`Idle backstop: ${IDLE_TIMEOUT / 60000} minutes`);
		try {
			await watchdog();
		} finally {
			cleanup();
		}
	},
	{ timeoutMs: 0 },
).catch((error: unknown) => {
	log(
		`Watchdog failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	cleanup();
	process.exitCode = 1;
});
