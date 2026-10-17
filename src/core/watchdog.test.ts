import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./file-lock";
import { isProcessAlive } from "./process/lifecycle";
import { readProcessIdentity } from "./process-identity";
import { publishRun } from "./run-registry";
import {
	ensureWatchdog,
	getWatchdogLockFile,
	getWatchdogPid,
	getWatchdogPidFile,
	resolveWatchdogRunnerPath,
} from "./watchdog";

const isolated = ["HOME", "DOCKER_HOST", "DOCKER_CONTEXT"] as const;
const saved = Object.fromEntries(
	isolated.map((key) => [key, process.env[key]]),
);
let home = "";

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-watchdog-"));
	process.env.HOME = home;
	// The runner sweeps as soon as it starts, inherits this environment, and
	// with an empty registry reads every stack it can list as unowned. It
	// finds the failing `docker` the test preload puts first on PATH; an
	// empty PATH is no substitute, since Bun then falls back to /usr/bin and
	// finds the real one. The dead DOCKER_HOST holds even for a runner that
	// outlives the preload's stub directory.
	process.env.DOCKER_HOST = "unix:///nonexistent/buncargo-watchdog-test.sock";
	delete process.env.DOCKER_CONTEXT;
});

afterAll(() => {
	for (const key of isolated) {
		const value = saved[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(home, { recursive: true, force: true });
});

/**
 * Give the runner a reason to stay alive.
 *
 * It exits the moment nothing on the machine needs watching, so a test that
 * wants to inspect the process has to own something first.
 */
async function claimSomething(): Promise<void> {
	await publishRun({
		sessionId: `watchdog-test-${crypto.randomUUID()}`,
		processIdentity: readProcessIdentity(process.pid),
		projectPrefix: "demo",
		projectName: "demo",
		root: home,
		worktree: null,
		pid: process.pid,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		hosts: null,
		cli: { program: process.execPath },
		apps: [],
		services: [{ name: "db", status: "ready" }],
	});
}

/**
 * Stop the runner and wait until the process is gone, not just its pid file:
 * the runner deletes the file before it exits, and its lock is released only
 * on exit. A test that started the next runner in that gap found the lock
 * held, so nothing started, and read no pid.
 */
async function stopWatchdog(): Promise<void> {
	const pid = getWatchdogPid();
	if (pid) process.kill(pid, "SIGTERM");
	for (let i = 0; i < 200 && getWatchdogPid(); i++) await Bun.sleep(10);
	for (let i = 0; pid && i < 200 && isProcessAlive(pid); i++)
		await Bun.sleep(10);
}

/** The parent pids of `pid`, nearest first, up to init. */
function ancestorsOf(pid: number): number[] {
	const chain: number[] = [];
	for (let current = pid; chain.length < 64; ) {
		const parent = Number(
			execFileSync("ps", ["-p", String(current), "-o", "ppid="], {
				encoding: "utf8",
			}).trim(),
		);
		if (!(parent > 0)) break;
		chain.push(parent);
		if (parent === 1) break;
		current = parent;
	}
	return chain;
}

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

describe("ensureWatchdog", () => {
	it("coalesces concurrent starts into one runner and is a no-op once it is up", async () => {
		try {
			await claimSomething();
			await Promise.all([
				ensureWatchdog({ verbose: false }),
				ensureWatchdog({ verbose: false }),
			]);
			const pid = getWatchdogPid();
			expect(pid).not.toBeNull();
			expect(JSON.parse(readFileSync(getWatchdogPidFile(), "utf8")).pid).toBe(
				pid,
			);
			await ensureWatchdog({ verbose: false });
			expect(getWatchdogPid()).toBe(pid);
		} finally {
			await stopWatchdog();
			expect(getWatchdogPid()).toBeNull();
		}
	});

	it("leaves the runner outside its own process tree", async () => {
		// The failure this whole sweep exists for: an agent harness tearing a
		// `buncargo dev` down with `pkill -P` enumerates children by parent
		// pid. `detached` alone kept the watchdog a child, so the tree kill
		// took the one process meant to outlive the run.
		try {
			await claimSomething();
			await ensureWatchdog({ verbose: false });
			const pid = getWatchdogPid();
			expect(pid).not.toBeNull();
			const ancestors = ancestorsOf(pid as number);
			expect(ancestors[0]).not.toBe(process.pid);
			// Reparented the moment the intermediate exited: to init/launchd, or
			// to a subreaper such as a systemd user manager, never to us.
			expect(ancestors).not.toContain(process.pid);
		} finally {
			await stopWatchdog();
		}
	});

	it("starts nothing while another process holds the runner lock", async () => {
		// The lock, not the pid file, is what says a watchdog is alive: a
		// `kill -9` leaves the pid file behind, and the kernel releases this.
		let release!: () => void;
		let acquired!: () => void;
		const isHeld = new Promise<void>((resolve) => {
			acquired = resolve;
		});
		const held = withFileLock(
			getWatchdogLockFile(),
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
					acquired();
				}),
		);
		await isHeld;
		try {
			await ensureWatchdog({ verbose: false });
			expect(getWatchdogPid()).toBeNull();
		} finally {
			release();
			await held;
		}
	});
});
