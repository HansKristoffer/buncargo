import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./file-lock";
import {
	ensureWatchdog,
	getWatchdogLockFile,
	getWatchdogPid,
	getWatchdogPidFile,
	resolveWatchdogRunnerPath,
} from "./watchdog";

const realHome = process.env.HOME;
let home = "";

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-watchdog-"));
	process.env.HOME = home;
});

afterAll(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
});

async function stopWatchdog(): Promise<void> {
	const pid = getWatchdogPid();
	if (pid) process.kill(pid, "SIGTERM");
	for (let i = 0; i < 200 && getWatchdogPid(); i++) await Bun.sleep(10);
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
			await ensureWatchdog({ verbose: false });
			const pid = getWatchdogPid();
			expect(pid).not.toBeNull();
			const parent = Number(
				execFileSync("ps", ["-p", String(pid), "-o", "ppid="], {
					encoding: "utf8",
				}).trim(),
			);
			expect(parent).not.toBe(process.pid);
			// Reparented to init/launchd the moment the intermediate exited.
			expect(parent).toBe(1);
		} finally {
			await stopWatchdog();
		}
	});

	it("starts nothing while another process holds the runner lock", async () => {
		// The lock, not the pid file, is what says a watchdog is alive: a
		// `kill -9` leaves the pid file behind, and the kernel releases this.
		let release!: () => void;
		const held = withFileLock(
			getWatchdogLockFile(),
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await Bun.sleep(20);
		try {
			await ensureWatchdog({ verbose: false });
			expect(getWatchdogPid()).toBeNull();
		} finally {
			release();
			await held;
		}
	});
});
