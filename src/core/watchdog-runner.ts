/**
 * Watchdog Runner
 *
 * Monitors heartbeat file and shuts down containers after the owner dies
 * or after the idle backstop (only when the owner is also gone).
 */

import {
	appendFileSync,
	existsSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	getContainerRuntimeAdapter,
	isContainerRuntimeName,
} from "../container-runtime";
import { isProcessAlive } from "./process";
import { parseHeartbeatPayload } from "./watchdog";
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

writeFileSync(pidFile, process.pid.toString());

function cleanup(): void {
	try {
		unlinkSync(pidFile);
	} catch {
		// File may not exist
	}
	try {
		unlinkSync(heartbeatFile);
	} catch {
		// File may not exist
	}
}

function shutdownContainers(): void {
	try {
		const runtime = getContainerRuntimeAdapter(
			isContainerRuntimeName(RUNTIME_NAME) ? RUNTIME_NAME : "docker",
			{ binary: RUNTIME_BINARY },
		);
		// No model: volumes are never removed here, and containers are found by
		// label, so the runner does not need the project's config.
		runtime.down({
			root: ROOT,
			projectName: PROJECT_NAME,
			composeFile: COMPOSE_FILE || undefined,
			verbose: false,
		});
	} catch {
		// Ignore errors
	}
}

process.on("SIGTERM", () => {
	cleanup();
	process.exit(0);
});

process.on("SIGINT", () => {
	cleanup();
	process.exit(0);
});

log(`Started for ${PROJECT_NAME} (PID: ${process.pid})`);
log(`Idle backstop: ${IDLE_TIMEOUT / 60000} minutes`);

/** Read the heartbeat, distinguishing "gone" from "cannot be parsed". */
function readHeartbeat(): HeartbeatReading {
	if (!existsSync(heartbeatFile)) {
		return { status: "missing" };
	}
	try {
		const payload = parseHeartbeatPayload(readFileSync(heartbeatFile, "utf-8"));
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
			reading.status === "ok" &&
			reading.payload.pid > 0 &&
			isProcessAlive(reading.payload.pid);

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
			log(`${verdict.reason}, shutting down...`);
			shutdownContainers();
			log("Containers stopped");
			cleanup();
			process.exit(0);
		}
	}
}

watchdog().catch((error: unknown) => {
	log(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
	cleanup();
	process.exit(1);
});
