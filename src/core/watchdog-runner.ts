/**
 * Watchdog Runner
 *
 * Monitors heartbeat file and shuts down containers after the owner dies
 * or after the idle backstop (only when the owner is also gone).
 */

import { execSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isProcessAlive } from "./process";
import { parseHeartbeatPayload } from "./watchdog";
import {
	WATCHDOG_IDLE_TIMEOUT_MS,
	WATCHDOG_OWNER_DEAD_GRACE_MS,
	WATCHDOG_POLL_INTERVAL_MS,
	WATCHDOG_SLEEP_JUMP_MS,
} from "./watchdog-constants";

const PROJECT_NAME = process.env.WATCHDOG_PROJECT_NAME ?? "";
const HEARTBEAT_FILE = process.env.WATCHDOG_HEARTBEAT_FILE ?? "";
const PID_FILE = process.env.WATCHDOG_PID_FILE ?? "";
const LOG_FILE = process.env.WATCHDOG_LOG_FILE ?? "";
const IDLE_TIMEOUT = Number.parseInt(
	process.env.WATCHDOG_TIMEOUT_MS ?? String(WATCHDOG_IDLE_TIMEOUT_MS),
	10,
);
const COMPOSE_ARG = process.env.WATCHDOG_COMPOSE_ARG ?? "";

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
		execSync(`docker compose ${COMPOSE_ARG} down`.trim(), {
			env: { ...process.env, COMPOSE_PROJECT_NAME: PROJECT_NAME },
			stdio: "ignore",
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

async function watchdog(): Promise<void> {
	let lastPoll = Date.now();
	let ownerDeadSince: number | null = null;

	while (true) {
		await new Promise((resolve) =>
			setTimeout(resolve, WATCHDOG_POLL_INTERVAL_MS),
		);
		const now = Date.now();
		if (now - lastPoll > WATCHDOG_SLEEP_JUMP_MS) {
			ownerDeadSince = null;
			log("Detected clock jump (likely sleep); resetting idle clock");
		}
		lastPoll = now;

		if (!existsSync(heartbeatFile)) {
			if (ownerDeadSince === null) ownerDeadSince = now;
			if (now - ownerDeadSince >= WATCHDOG_OWNER_DEAD_GRACE_MS) {
				log(
					"Heartbeat file missing and owner-dead grace elapsed, shutting down...",
				);
				shutdownContainers();
				cleanup();
				process.exit(0);
			}
			continue;
		}

		let payload: ReturnType<typeof parseHeartbeatPayload> = null;
		try {
			payload = parseHeartbeatPayload(readFileSync(heartbeatFile, "utf-8"));
		} catch {
			payload = null;
		}

		if (!payload) {
			if (ownerDeadSince === null) ownerDeadSince = now;
			continue;
		}

		const ownerAlive = payload.pid > 0 && isProcessAlive(payload.pid);
		if (ownerAlive) {
			ownerDeadSince = null;
			continue;
		}

		if (ownerDeadSince === null) ownerDeadSince = now;
		const ownerDeadFor = now - ownerDeadSince;
		const idleFor = now - payload.ts;
		if (
			ownerDeadFor >= WATCHDOG_OWNER_DEAD_GRACE_MS ||
			idleFor > IDLE_TIMEOUT
		) {
			log(
				`Owner gone (dead ${Math.ceil(ownerDeadFor / 1000)}s, idle ${Math.ceil(idleFor / 1000)}s), shutting down...`,
			);
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
