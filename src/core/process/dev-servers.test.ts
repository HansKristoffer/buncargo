import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServers } from "./dev-servers";
import { signalProcessTree } from "./port-owner";

describe("startDevServers", () => {
	it("skips healthEndpoint: false / devCommand: false and honors attach", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-process-"));
		const basePort = 45100 + Math.floor(Math.random() * 200);
		const skipPort = basePort;
		const silentPort = basePort + 1;
		const attachPort = basePort + 2;
		const marker = join(root, "attached.txt");
		let silentPid: number | undefined;

		try {
			const pids = await startDevServers(
				{
					skipped: { port: skipPort, devCommand: false },
					silent: {
						port: silentPort,
						healthEndpoint: false,
						devCommand: "bun -e 'setInterval(() => {}, 60000)'",
					},
				},
				root,
				{},
				{ skipped: skipPort, silent: silentPort },
				{ verbose: false, waitForExit: false },
			);

			expect(pids.skipped).toBeUndefined();
			expect(typeof pids.silent).toBe("number");
			silentPid = pids.silent;

			await startDevServers(
				{
					app: {
						port: attachPort,
						healthEndpoint: false,
						devCommand: `bun -e ${JSON.stringify(`await Bun.write(${JSON.stringify(marker)}, process.argv[1] ?? "")`)}`,
					},
				},
				root,
				{},
				{ app: attachPort },
				{
					verbose: false,
					attach: "app",
					extraArgs: ["from-attach"],
					waitForExit: true,
					waitForHealth: async () => {},
				},
			);

			expect(await Bun.file(marker).text()).toBe("from-attach");
		} finally {
			if (silentPid) {
				signalProcessTree(silentPid, "SIGTERM");
			}
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("startDevServers supervision", () => {
	/**
	 * Apps are spawned in a loop and supervised only once the wave is up, so an
	 * app that dies in between emits its `close` before anything is listening.
	 * That event is gone for good; the run used to wait forever for a process
	 * that was never coming back, with nothing printed to say so.
	 */
	it("notices an app that exited before supervision started", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-early-exit-"));
		const port = 45600 + Math.floor(Math.random() * 200);
		const exits: Array<[string, number | null]> = [];

		try {
			await startDevServers(
				{
					quick: {
						port,
						devCommand: "bun -e 'process.exit(0)'",
						healthEndpoint: false,
					},
				},
				root,
				{},
				{ quick: port },
				{
					verbose: false,
					waitForExit: true,
					// Long enough that a lost `close` event shows up as a timeout
					// rather than as a pass.
					waitForHealth: async () => {
						await new Promise((resolve) => setTimeout(resolve, 300));
					},
					onAppExit: (name, code) => exits.push([name, code]),
				},
			);
			expect(exits).toEqual([["quick", 0]]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 10_000);

	it("fails the run when an app exits non-zero before supervision", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-early-fail-"));
		const port = 45800 + Math.floor(Math.random() * 200);

		try {
			await expect(
				startDevServers(
					{
						broken: {
							port,
							devCommand: "bun -e 'process.exit(3)'",
							healthEndpoint: false,
						},
					},
					root,
					{},
					{ broken: port },
					{
						verbose: false,
						waitForExit: true,
						waitForHealth: async () => {
							await new Promise((resolve) => setTimeout(resolve, 300));
						},
					},
				),
			).rejects.toThrow(/exited with code 3/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 10_000);
});

describe("startup process ownership", () => {
	function alive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}
	const idle = {
		port: 1,
		devCommand: "bun -e 'setInterval(() => {}, 1000)'",
		healthEndpoint: false as const,
	};

	for (const phase of ["health", "tunnel", "second wave"] as const) {
		it(`cleans up every owned child on ${phase} failure`, async () => {
			const owned: number[] = [];
			try {
				await expect(
					startDevServers(
						{ first: idle, second: { ...idle, needsPublicUrls: true } },
						process.cwd(),
						{},
						{},
						{
							verbose: false,
							shutdownGraceMs: 100,
							onAppSpawned: (_name, pid) => owned.push(pid),
							waitForHealth: async (apps) => {
								if (
									phase === "health" ||
									(phase === "second wave" && apps.second)
								)
									throw new Error("failed readiness");
							},
							onAfterWave1: async () => {
								if (phase === "tunnel") throw new Error("failed tunnel");
							},
						},
					),
				).rejects.toThrow("failed");
				expect(owned.length).toBe(phase === "second wave" ? 2 : 1);
				for (const pid of owned) expect(alive(pid)).toBe(false);
			} finally {
				for (const pid of owned) {
					if (alive(pid)) signalProcessTree(pid, "SIGKILL");
				}
			}
		});
	}

	it("cancels a hung health callback and terminates its app", async () => {
		const controller = new AbortController();
		let pid: number | undefined;
		const start = performance.now();
		await expect(
			startDevServers(
				{ app: idle },
				process.cwd(),
				{},
				{},
				{
					verbose: false,
					signal: controller.signal,
					shutdownGraceMs: 100,
					onAppSpawned: (_name, spawnedPid) => {
						pid = spawnedPid;
					},
					waitForHealth: async () => {
						setTimeout(() => controller.abort(new Error("test cancelled")), 50);
						return new Promise<void>(() => {});
					},
				},
			),
		).rejects.toThrow("test cancelled");
		expect(performance.now() - start).toBeLessThan(2000);
		expect(pid).toBeDefined();
		expect(alive(Number(pid))).toBe(false);
	});

	it("observes spawn errors before starting the health wait", async () => {
		await expect(
			startDevServers(
				{ app: { ...idle, cwd: "/missing/buncargo/startup" } },
				process.cwd(),
				{},
				{},
				{
					verbose: false,
					waitForHealth: async () => new Promise<void>(() => {}),
				},
			),
		).rejects.toThrow('Failed to start app "app"');
	});

	it("reports readiness only after both app waves", async () => {
		const events: string[] = [];
		const owned: number[] = [];
		try {
			await startDevServers(
				{ first: idle, second: { ...idle, needsPublicUrls: true } },
				process.cwd(),
				{},
				{},
				{
					verbose: false,
					onAppSpawned: (_name, pid) => owned.push(pid),
					waitForHealth: async (apps) => {
						events.push(...Object.keys(apps));
					},
					onAfterWave1: async () => {
						events.push("tunnels");
					},
					onReady: () => {
						events.push("ready");
					},
				},
			);
			expect(events).toEqual(["first", "tunnels", "second", "ready"]);
		} finally {
			for (const pid of owned) signalProcessTree(pid, "SIGTERM");
		}
	});
});

describe("startup signals", () => {
	it("handles repeated SIGTERM during readiness and waits for owned descendants", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-signal-"));
		const marker = join(root, "spawned.json");
		const childMarker = join(root, "descendant.pid");
		const importPath = new URL("./dev-servers.ts", import.meta.url).href;
		const script = join(root, "driver.ts");
		const descendant = join(root, "app.ts");
		await Bun.write(
			descendant,
			`import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
await Bun.write(${JSON.stringify(childMarker)}, String(child.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);`,
		);
		await Bun.write(
			script,
			`import { startDevServers } from ${JSON.stringify(importPath)};
await startDevServers({ app: { port: 1, devCommand: "bun app.ts" } }, ${JSON.stringify(root)}, {}, {}, {
verbose: false, waitForExit: true, shutdownGraceMs: 150,
runtime: {name: "docker", containerPortOwners: () => new Map()},
onAppSpawned: (_name, pid) => { void Bun.write(${JSON.stringify(marker)}, String(pid)); },
waitForHealth: async () => new Promise(() => {}),
});`,
		);
		const driver = Bun.spawn([process.execPath, script], {
			stdout: "pipe",
			stderr: "pipe",
		});
		let appPid: number | undefined;
		let descendantPid: number | undefined;
		try {
			const deadline = performance.now() + 5000;
			while (
				!(await Bun.file(childMarker).exists()) &&
				performance.now() < deadline
			)
				await Bun.sleep(20);
			appPid = Number(await Bun.file(marker).text());
			descendantPid = Number(await Bun.file(childMarker).text());
			await Bun.sleep(60);
			driver.kill("SIGTERM");
			setTimeout(() => driver.kill("SIGTERM"), 20);
			const exit = await driver.exited;
			const stderr = await new Response(driver.stderr).text();
			expect(stderr).toBe("");
			expect(exit).toBe(0);
			for (const pid of [appPid, descendantPid])
				expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			driver.kill("SIGKILL");
			if (appPid) {
				try {
					signalProcessTree(appPid, "SIGKILL");
				} catch {}
			}
			if (descendantPid) {
				try {
					process.kill(descendantPid, "SIGKILL");
				} catch {}
			}
			await rm(root, { recursive: true, force: true });
		}
	}, 10000);
});
