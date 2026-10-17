import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./file-lock";
import { isProcessAlive } from "./process/lifecycle";
import { readProcessIdentity } from "./process-identity";
import { publishRun } from "./run-registry";
import { buncargoVersion } from "./version";
import {
	ensureWatchdog,
	getWatchdogLockFile,
	getWatchdogPid,
	getWatchdogPidFile,
	isOutdatedWatchdog,
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

describe("the watchdog runner", () => {
	it("exits without sweeping once the process it may not outlive has ended", async () => {
		// A watchdog a test run started outlived it and, from a temporary HOME,
		// swept real stacks on the machine's daemon.
		const parent = Bun.spawn([process.execPath, "-e", ""]);
		await parent.exited;

		const runner = Bun.spawn([process.execPath, resolveWatchdogRunnerPath()], {
			cwd: home,
			env: { ...process.env, BUNCARGO_WATCHDOG_PARENT: `${parent.pid}:` },
			stdio: ["ignore", "pipe", "inherit"],
		});
		const exited = await Promise.race([
			runner.exited.then(() => true),
			Bun.sleep(15_000).then(() => false),
		]);
		if (!exited) runner.kill();

		const output = await new Response(runner.stdout).text();
		expect(exited).toBe(true);
		expect(output).toContain(
			`Process ${parent.pid}, which BUNCARGO_WATCHDOG_PARENT names, has ended; exiting`,
		);
		expect(output).not.toContain("Removed");
	}, 20_000);
});

describe("isOutdatedWatchdog", () => {
	it("replaces only strictly older code, and one that recorded no version", () => {
		expect(isOutdatedWatchdog({ version: "12.4.0" }, "13.0.0")).toBe(true);
		expect(isOutdatedWatchdog({}, "13.0.0")).toBe(true);
		// Equal or newer is left alone, so two current versions never take
		// turns replacing each other.
		expect(isOutdatedWatchdog({ version: "13.0.0" }, "13.0.0")).toBe(false);
		expect(isOutdatedWatchdog({ version: "13.1.0" }, "13.0.0")).toBe(false);
		expect(isOutdatedWatchdog({}, undefined)).toBe(false);
	});
});

/**
 * A process that behaves like a runner as `ensureWatchdog` sees one: it
 * holds the runner lock, writes the pid file with the given version, and
 * exits on SIGTERM. Started and stopped by the test, so the only process
 * `ensureWatchdog` can signal is one this test owns.
 */
async function startStubRunner(
	version: string | undefined,
	options: { identity?: boolean } = {},
) {
	const script = join(home, "stub-runner.ts");
	writeFileSync(
		script,
		`import { writeFileSync } from "node:fs";
import { withFileLock } from ${JSON.stringify(join(import.meta.dir, "file-lock.ts"))};
import { readCurrentProcessIdentityAsync } from ${JSON.stringify(join(import.meta.dir, "process-identity.ts"))};
const [pidFile, lockFile, identity, version, ready] = process.argv.slice(2);
process.on("SIGTERM", () => process.exit(0));
await withFileLock(lockFile, async () => {
	const processIdentity = identity === "yes" ? await readCurrentProcessIdentityAsync() : undefined;
	writeFileSync(pidFile, JSON.stringify({ pid: process.pid, processIdentity, version: version || undefined }));
	writeFileSync(ready, "");
	await new Promise(() => setInterval(() => {}, 60_000));
}, { timeoutMs: 0 });
`,
	);
	const ready = join(home, `stub-ready-${crypto.randomUUID()}`);
	const stub = Bun.spawn(
		[
			process.execPath,
			script,
			getWatchdogPidFile(),
			getWatchdogLockFile(),
			options.identity === false ? "no" : "yes",
			version ?? "",
			ready,
		],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);
	const deadline = Date.now() + 10_000;
	while (!existsSync(ready)) {
		if (stub.exitCode !== null || Date.now() > deadline)
			throw new Error("The stub runner did not start");
		await Bun.sleep(10);
	}
	return stub;
}

describe("ensureWatchdog and an older watchdog", () => {
	for (const version of ["12.4.0", undefined]) {
		it(`replaces a watchdog of ${version ?? "no recorded version"} with this buncargo's`, async () => {
			// An older runner sweeps every checkout on the machine with its own
			// rules for as long as it lives, whichever worktree started it.
			await claimSomething();
			const stub = await startStubRunner(version);
			try {
				await ensureWatchdog({ verbose: false });
				expect(await stub.exited).toBe(0);
				const pid = getWatchdogPid();
				expect(pid).not.toBeNull();
				expect(pid).not.toBe(stub.pid);
				expect(
					JSON.parse(readFileSync(getWatchdogPidFile(), "utf8")).version,
				).toBe(buncargoVersion());
			} finally {
				stub.kill();
				await stopWatchdog();
			}
		});
	}

	for (const version of [buncargoVersion(), "999.0.0"]) {
		it(`leaves a watchdog of ${version === "999.0.0" ? "a newer" : "the same"} buncargo running`, async () => {
			const stub = await startStubRunner(version);
			try {
				await ensureWatchdog({ verbose: false });
				expect(stub.exitCode).toBeNull();
				expect(getWatchdogPid()).toBe(stub.pid);
			} finally {
				stub.kill();
				await stub.exited;
			}
		});
	}

	it("never signals a watchdog whose identity it cannot confirm", async () => {
		// `stop` refuses an app without a recorded identity for the same
		// reason: the pid may be someone else's by now.
		const stub = await startStubRunner("1.0.0", { identity: false });
		try {
			await ensureWatchdog({ verbose: false });
			expect(stub.exitCode).toBeNull();
			expect(getWatchdogPid()).toBe(stub.pid);
		} finally {
			stub.kill();
			await stub.exited;
		}
	});
});
