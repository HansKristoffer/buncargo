import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { simpleHash } from "./hash";
import {
	getHeartbeatFile,
	getWatchdogComposeArg,
	getWatchdogPidFile,
	parseHeartbeatPayload,
	readHeartbeat,
	readHeartbeatPayload,
	removeHeartbeatFile,
	resolveWatchdogRunnerPath,
	startHeartbeat,
	stopHeartbeat,
} from "./watchdog";

// ═══════════════════════════════════════════════════════════════════════════
// getHeartbeatFile Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("getHeartbeatFile", () => {
	it("returns correct path for project name", () => {
		const result = getHeartbeatFile("myapp");

		expect(result).toBe("/tmp/myapp-heartbeat");
	});

	it("handles project names with hyphens", () => {
		const result = getHeartbeatFile("my-app-project");

		expect(result).toBe("/tmp/my-app-project-heartbeat");
	});

	it("handles project names with numbers", () => {
		const result = getHeartbeatFile("myapp123");

		expect(result).toBe("/tmp/myapp123-heartbeat");
	});

	it("namespaces by root hash so worktrees do not collide", () => {
		const root = "/Users/me/worktrees/feature";
		const hash = simpleHash(root).toString(16).slice(0, 8);
		expect(getHeartbeatFile("myapp", root)).toBe(
			`/tmp/myapp-${hash}-heartbeat`,
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// getWatchdogPidFile Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("getWatchdogPidFile", () => {
	it("returns correct path for project name", () => {
		const result = getWatchdogPidFile("myapp");

		expect(result).toBe("/tmp/myapp-watchdog.pid");
	});

	it("handles project names with hyphens", () => {
		const result = getWatchdogPidFile("my-app-project");

		expect(result).toBe("/tmp/my-app-project-watchdog.pid");
	});

	it("handles project names with numbers", () => {
		const result = getWatchdogPidFile("myapp123");

		expect(result).toBe("/tmp/myapp123-watchdog.pid");
	});
});

describe("getWatchdogComposeArg", () => {
	it("returns empty string when compose file is missing", () => {
		expect(getWatchdogComposeArg()).toBe("");
	});

	it("returns quoted compose -f arg for generated file", () => {
		expect(
			getWatchdogComposeArg(".buncargo/docker-compose.generated.yml"),
		).toBe('-f ".buncargo/docker-compose.generated.yml"');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// readHeartbeat Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("readHeartbeat", () => {
	const testProject = "test-heartbeat-project";

	afterEach(() => {
		// Clean up test file
		removeHeartbeatFile(testProject);
	});

	it("returns null when file does not exist", () => {
		const result = readHeartbeat("nonexistent-project-xyz");

		expect(result).toBeNull();
	});

	it("returns timestamp when file contains valid number", () => {
		const heartbeatFile = getHeartbeatFile(testProject);
		const timestamp = Date.now();
		writeFileSync(heartbeatFile, timestamp.toString());

		const result = readHeartbeat(testProject);

		expect(result).toBe(timestamp);
	});

	it("reads JSON heartbeat payloads", () => {
		const heartbeatFile = getHeartbeatFile(testProject);
		const timestamp = Date.now();
		writeFileSync(
			heartbeatFile,
			JSON.stringify({ ts: timestamp, pid: process.pid }),
		);

		expect(readHeartbeat(testProject)).toBe(timestamp);
	});

	it("returns null when file contains invalid content", () => {
		const heartbeatFile = getHeartbeatFile(testProject);
		writeFileSync(heartbeatFile, "not-a-number");

		const result = readHeartbeat(testProject);

		expect(result).toBeNull();
	});

	it("returns null when file is empty", () => {
		const heartbeatFile = getHeartbeatFile(testProject);
		writeFileSync(heartbeatFile, "");

		const result = readHeartbeat(testProject);

		expect(result).toBeNull();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// removeHeartbeatFile Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("removeHeartbeatFile", () => {
	const testProject = "test-remove-heartbeat-project";

	it("removes existing heartbeat file", () => {
		const heartbeatFile = getHeartbeatFile(testProject);
		writeFileSync(heartbeatFile, "12345");
		expect(existsSync(heartbeatFile)).toBe(true);

		removeHeartbeatFile(testProject);

		expect(existsSync(heartbeatFile)).toBe(false);
	});

	it("does not throw when file does not exist", () => {
		// Should not throw
		expect(() => removeHeartbeatFile("nonexistent-project-xyz")).not.toThrow();
	});
});

describe("stopHeartbeat", () => {
	const testProject = "test-stop-heartbeat-project";

	afterEach(() => {
		removeHeartbeatFile(testProject);
	});

	// Unlinking made a clean Ctrl-C look like a crash, so the watchdog tore the
	// stack down inside the crash grace and restarts recreated containers.
	it("leaves a released marker instead of removing the file", () => {
		startHeartbeat(testProject, 60_000);
		stopHeartbeat();

		const payload = readHeartbeatPayload(testProject);
		expect(existsSync(getHeartbeatFile(testProject))).toBe(true);
		expect(payload?.released).toBe(true);
		// pid 0 never matches a live process, so the owner reads as gone.
		expect(payload?.pid).toBe(0);
	});
});

describe("parseHeartbeatPayload", () => {
	it("preserves the released marker", () => {
		expect(
			parseHeartbeatPayload(JSON.stringify({ ts: 5, pid: 0, released: true })),
		).toEqual({ ts: 5, pid: 0, released: true });
	});

	it("omits the marker for a normal heartbeat", () => {
		expect(parseHeartbeatPayload(JSON.stringify({ ts: 5, pid: 42 }))).toEqual({
			ts: 5,
			pid: 42,
		});
	});
});

describe("resolveWatchdogRunnerPath", () => {
	it("resolves a real runner file next to source or dist", () => {
		const path = resolveWatchdogRunnerPath();
		expect(existsSync(path)).toBe(true);
		expect(
			path.endsWith("watchdog-runner.ts") ||
				path.endsWith("watchdog-runner.js"),
		).toBe(true);
	});
});
