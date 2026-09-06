import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { simpleHash } from "./hash";
import {
	createHeartbeatOwner,
	getHeartbeatFile,
	getHeartbeatOwnersDir,
	getWatchdogLogFile,
	getWatchdogPid,
	getWatchdogPidFile,
	parseHeartbeatPayload,
	readHeartbeat,
	readHeartbeatPayload,
	removeHeartbeatFile,
	resolveWatchdogRunnerPath,
	spawnWatchdog,
	startHeartbeat,
	stopHeartbeat,
	stopWatchdog,
	withWatchdogProjectLock,
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

describe("independent heartbeat owners", () => {
	const projects: string[] = [];
	const owners: ReturnType<typeof createHeartbeatOwner>[] = [];
	afterEach(() => {
		for (const owner of owners.splice(0)) owner.stop();
		stopHeartbeat();
		for (const project of projects.splice(0)) {
			removeHeartbeatFile(project);
			rmSync(getHeartbeatOwnersDir(project), { recursive: true, force: true });
		}
	});
	function project() {
		const name = `heartbeat-${process.pid}-${crypto.randomUUID()}`;
		projects.push(name);
		return name;
	}
	it("retains a live session when another session in the same root stops", () => {
		const name = project();
		const first = createHeartbeatOwner(name);
		const second = createHeartbeatOwner(name);
		owners.push(first, second);
		first.start(60000);
		second.start(60000);
		second.stop();
		expect(readHeartbeatPayload(name)?.pid).toBe(process.pid);
		expect(readHeartbeatPayload(name)?.released).toBeUndefined();
		first.stop();
		expect(readHeartbeatPayload(name)?.released).toBe(true);
	});
	it("does not overwrite or release another project's timer", async () => {
		const firstName = project();
		const secondName = project();
		startHeartbeat(firstName, 20);
		startHeartbeat(secondName, 20);
		stopHeartbeat(firstName);
		const first = readHeartbeatPayload(firstName);
		await Bun.sleep(60);
		expect(readHeartbeatPayload(firstName)).toEqual(first);
		expect(readHeartbeatPayload(secondName)?.pid).toBe(process.pid);
	});
	it("starting an owner twice is idempotent and stop clears its timer", async () => {
		const name = project();
		const owner = createHeartbeatOwner(name);
		owners.push(owner);
		owner.start(20);
		owner.start(20);
		expect(readdirSync(getHeartbeatOwnersDir(name))).toHaveLength(1);
		owner.stop();
		const before = readFileSync(getHeartbeatFile(name), "utf8");
		await Bun.sleep(60);
		expect(readFileSync(getHeartbeatFile(name), "utf8")).toBe(before);
	});
	it("a delayed teardown sees the owner that registered while it waited", async () => {
		const name = project();
		const owner = createHeartbeatOwner(name);
		owners.push(owner);
		let release!: () => void;
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = withWatchdogProjectLock(name, "/tmp", async () => {
			entered();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		await ready;
		const teardown = withWatchdogProjectLock(
			name,
			"/tmp",
			async () => readHeartbeatPayload(name)?.pid,
		);
		owner.start(60000);
		release();
		await held;
		expect(await teardown).toBe(process.pid);
	});
});

describe("heartbeat owners across processes", () => {
	it("keeps the remaining owner's stack alive when a peer process dies", async () => {
		const project = `heartbeat-processes-${process.pid}-${crypto.randomUUID()}`;
		const code = `import { createHeartbeatOwner } from ${JSON.stringify(join(import.meta.dir, "watchdog.ts"))}; const owner = createHeartbeatOwner(${JSON.stringify(project)}); owner.start(50); setInterval(() => {}, 1000);`;
		const first = Bun.spawn([process.execPath, "--eval", code], {
			stdout: "ignore",
			stderr: "pipe",
		});
		const second = Bun.spawn([process.execPath, "--eval", code], {
			stdout: "ignore",
			stderr: "pipe",
		});
		try {
			for (let i = 0; i < 100; i++) {
				if (
					existsSync(getHeartbeatOwnersDir(project)) &&
					readdirSync(getHeartbeatOwnersDir(project)).filter((name) =>
						name.endsWith(".json"),
					).length === 2
				)
					break;
				await Bun.sleep(10);
			}
			expect(
				readdirSync(getHeartbeatOwnersDir(project)).filter((name) =>
					name.endsWith(".json"),
				),
			).toHaveLength(2);
			first.kill("SIGKILL");
			await first.exited;
			expect(readHeartbeatPayload(project)?.pid).toBe(second.pid);
		} finally {
			first.kill("SIGKILL");
			second.kill("SIGKILL");
			await Promise.all([first.exited, second.exited]);
			removeHeartbeatFile(project);
		}
	});
});

describe("watchdog startup ownership", () => {
	it("coalesces concurrent starts and uses the running interpreter", async () => {
		const project = `watchdog-${process.pid}-${crypto.randomUUID()}`;
		const root = "/tmp";
		const owner = createHeartbeatOwner(project, root);
		owner.start(60000);
		try {
			await Promise.all([
				spawnWatchdog(project, root, { verbose: false }),
				spawnWatchdog(project, root, { verbose: false }),
			]);
			const pid = getWatchdogPid(project, root);
			expect(pid).not.toBeNull();
			expect(
				JSON.parse(readFileSync(getWatchdogPidFile(project, root), "utf8")).pid,
			).toBe(pid);
		} finally {
			stopWatchdog(project, root);
			for (let i = 0; i < 100 && getWatchdogPid(project, root); i++)
				await Bun.sleep(10);
			owner.stop();
			removeHeartbeatFile(project, root);
			for (const path of [
				getWatchdogPidFile(project, root),
				getWatchdogLogFile(project, root),
			])
				rmSync(path, { force: true });
		}
	});
});
