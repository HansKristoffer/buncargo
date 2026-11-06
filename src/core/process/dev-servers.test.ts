import { describe, expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toError } from "hanzio";
import type { ContainerRuntimeAdapter } from "../../container-runtime/types";
import { startFakeInfisical } from "../secrets/fake-infisical.testing";
import { clearScopeSecretsCache } from "../secrets/infisical";
import { startDevServers, stopDevServers } from "./dev-servers";
import { signalProcessTree } from "./port-owner";
import { RunOutput } from "./run-output";

/** Poll `check` until it holds, failing the test after `timeoutMs`. */
async function eventually(check: () => boolean, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (!check() && Date.now() < deadline) await Bun.sleep(20);
	expect(check()).toBe(true);
}

// Ports the OS hands out, held together so they differ. A random port in a
// fixed range collided with another test's app still letting go of it.
async function freePorts(count: number): Promise<number[]> {
	const servers = Array.from({ length: count }, () =>
		Bun.serve({ port: 0, fetch: () => new Response() }),
	);
	const ports = servers.map((server) => server.port ?? 0);
	await Promise.all(servers.map((server) => server.stop(true)));
	return ports;
}

async function freePort(): Promise<number> {
	const [port] = await freePorts(1);
	return port;
}

describe("startDevServers", () => {
	it("skips healthEndpoint: false / devCommand: false and honors attach", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-process-"));
		const [skipPort, silentPort, attachPort] = await freePorts(3);
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

/**
 * The injection used to live in `startAppServers`, which `buncargo dev` does
 * not call — it spawns through `startDevServers` itself, so the whole feature
 * was dead code for the CLI. Asserting it at this function is the point: it is
 * the one both spawn paths share.
 */
describe("startDevServers secret injection", () => {
	it("injects an app's Infisical secrets under its computed env", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-secrets-spawn-"));
		const savedHome = process.env.HOME;
		const savedPath = process.env.BUNCARGO_INFISICAL_PATH;
		const infisical = startFakeInfisical();
		infisical.projects.p1 = {
			secrets: { OPENAI_API_KEY: "sk-project", PORT: "9999", BLANK: "" },
		};
		process.env.HOME = infisical.home;
		process.env.BUNCARGO_INFISICAL_PATH = infisical.cliPath;
		const marker = join(root, "env.json");
		const port = await freePort();
		const secrets = { projectId: "p1", siteUrl: infisical.siteUrl };

		try {
			await startDevServers(
				{
					api: {
						port,
						healthEndpoint: false,
						devCommand: `bun -e ${JSON.stringify(
							`await Bun.write(${JSON.stringify(marker)}, JSON.stringify({ secret: process.env.OPENAI_API_KEY ?? null, port: process.env.PORT ?? null, blank: process.env.BLANK ?? null }))`,
						)}`,
						secrets,
					},
				},
				root,
				{ api: { PORT: String(port) } },
				{ api: port },
				{
					verbose: false,
					waitForExit: true,
					waitForHealth: async () => {},
				},
			);

			expect(JSON.parse(await Bun.file(marker).text())).toEqual({
				secret: "sk-project",
				// The computed env wins over a key of the same name.
				port: String(port),
				// An empty export is left out, so the app's own loader still fetches.
				blank: null,
			});

			// A required key nobody provides stops the run before anything spawns.
			await expect(
				startDevServers(
					{
						api: {
							port,
							healthEndpoint: false,
							devCommand: "exit 0",
							secrets: {
								...secrets,
								required: ["OPENAI_API_KEY", "STRIPE_KEY"],
							},
						},
					},
					root,
					{},
					{ api: port },
					{ verbose: false, waitForExit: true, waitForHealth: async () => {} },
				),
			).rejects.toThrow("api: STRIPE_KEY");
		} finally {
			if (savedHome === undefined) delete process.env.HOME;
			else process.env.HOME = savedHome;
			if (savedPath === undefined) delete process.env.BUNCARGO_INFISICAL_PATH;
			else process.env.BUNCARGO_INFISICAL_PATH = savedPath;
			clearScopeSecretsCache();
			infisical.stop();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("startDevServers ordering, prebuild and captures", () => {
	it("starts after health, prebuilds first, and restarts on a capture", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-order-"));
		const apiPort = await freePort();
		const log = join(root, "events.log");
		const append = (line: string) =>
			`bun -e ${JSON.stringify(`require("node:fs").appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${line}\n`)})`)}`;
		const captures: string[] = [];
		let pids: Record<string, number> = {};

		try {
			pids = await startDevServers(
				{
					api: {
						port: apiPort,
						devCommand: `${append("api spawned")} && bun -e 'Bun.serve({ port: ${apiPort}, fetch: () => new Response("ok") }); setInterval(() => {}, 60000)'`,
					},
					// Would log "api down" if it spawned before api answered.
					web: {
						kind: "worker",
						startAfter: ["api"],
						devCommand: `bun -e 'fetch("http://localhost:${apiPort}/").then(() => require("node:fs").appendFileSync(${JSON.stringify(log)}, "web saw api\\n"), () => require("node:fs").appendFileSync(${JSON.stringify(log)}, "api down\\n")); setInterval(() => {}, 60000)'`,
					},
					ext: {
						kind: "worker",
						prebuild: append("ext prebuilt"),
						// Printed after a pause: an app that has not spawned yet gets the
						// new value anyway, so only a running one is restarted.
						devCommand: `${append("ext spawned")} && sleep 1 && echo 'Using URL: https://one.example/api/rpc' && sleep 60`,
						captures: {
							url: { pattern: /Using URL:\s*(\S+)/, as: "publicUrl" },
						},
					},
					dependent: {
						kind: "worker",
						restartOn: ["captured.url"],
						devCommand: `${append("dependent spawned")} && sleep 60`,
					},
				},
				root,
				{},
				{ api: apiPort },
				{
					verbose: false,
					waitForExit: false,
					onCapture: (app, captured) => {
						captures.push(`${app}:${captured.name}=${captured.value}`);
						return ["captured.url"];
					},
				},
			);

			const deadline = Date.now() + 10_000;
			const events = async () =>
				(await Bun.file(log).exists())
					? (await Bun.file(log).text()).split("\n")
					: [];
			// The restart and web's own fetch race each other: wait for both.
			const settled = (lines: string[]) =>
				lines.filter((line) => line === "dependent spawned").length >= 2 &&
				(lines.includes("web saw api") || lines.includes("api down"));
			while (Date.now() < deadline && !settled(await events())) {
				await Bun.sleep(50);
			}
			const lines = await events();

			expect(lines).toContain("web saw api");
			expect(lines).not.toContain("api down");
			expect(lines.indexOf("ext prebuilt")).toBeLessThan(
				lines.indexOf("ext spawned"),
			);
			expect(captures).toEqual(["ext:url=https://one.example"]);
			// Spawned once, then again when the value it restarts on arrived.
			expect(lines.filter((line) => line === "dependent spawned")).toHaveLength(
				2,
			);
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);
});

describe("stopDevServers", () => {
	it("returns after a library run's apps' last words are printed", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-last-words-"));
		const port = await freePort();
		let printed = "";
		const write = spyOn(process.stdout, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				printed += String(chunk);
				return true;
			},
		);
		let pids = {};
		try {
			// Interactive with no terminal to attach to, so it gets a screen; its
			// goodbye has no newline, so only the screen's final flush emits it.
			const script = `process.on("SIGTERM", () => { process.stdout.write("last words"); process.exit(0); }); console.log("started"); setInterval(() => {}, 60000);`;
			pids = await startDevServers(
				{
					app: {
						port,
						healthEndpoint: false,
						interactive: true,
						devCommand: `bun -e ${JSON.stringify(script)}`,
					},
				},
				root,
				{},
				{ app: port },
				{ verbose: false, waitForExit: false },
			);
			const deadline = Date.now() + 10_000;
			while (!printed.includes("started") && Date.now() < deadline)
				await Bun.sleep(20);
			expect(printed).toContain("started");

			await stopDevServers(pids);
			expect(Bun.stripANSI(printed)).toContain("last words");
		} finally {
			write.mockRestore();
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);
});

describe("detached app supervision", () => {
	it("adopts a daemonized listener and stops it with the session", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-detached-"));
		const port = await freePort();
		const marker = join(root, "child.pid");
		await Bun.write(
			join(root, "child.ts"),
			`Bun.serve({ port: ${port}, fetch: () => new Response("ok") }); await Bun.write(${JSON.stringify(marker)}, String(process.pid));`,
		);
		await Bun.write(
			join(root, "parent.ts"),
			`import { spawn } from "node:child_process"; const child = spawn(process.execPath, ["child.ts"], { detached: true, stdio: "ignore" }); child.unref(); while (!(await Bun.file(${JSON.stringify(marker)}).exists())) await Bun.sleep(10);`,
		);
		const spawned: number[] = [];
		const exits: string[] = [];
		let pids: Record<string, number> = {};
		try {
			pids = await startDevServers(
				{ app: { port, devCommand: "bun parent.ts" } },
				root,
				{},
				{ app: port },
				{
					verbose: false,
					skipContainers: true,
					onAppSpawned: (_name, pid) => spawned.push(pid),
					onAppExit: (name) => exits.push(name),
				},
			);
			const childPid = Number(await Bun.file(marker).text());
			const deadline = Date.now() + 5000;
			while (pids.app !== childPid && Date.now() < deadline)
				await Bun.sleep(20);
			expect(pids.app).toBe(childPid);
			expect(spawned).toHaveLength(2);
			expect(exits).toEqual([]);
			await stopDevServers(pids);
			await expect(fetch(`http://localhost:${port}`)).rejects.toThrow();
		} finally {
			await stopDevServers(pids);
			if (await Bun.file(marker).exists()) {
				try {
					signalProcessTree(Number(await Bun.file(marker).text()), "SIGKILL");
				} catch {}
			}
			await rm(root, { recursive: true, force: true });
		}
	}, 15000);

	it("reports a clean exit that leaves no listener", async () => {
		const exits: (number | null)[] = [];
		await startDevServers(
			{ app: { port: 47001, devCommand: "exit 0", healthEndpoint: false } },
			process.cwd(),
			{},
			{ app: 47001 },
			{
				verbose: false,
				skipContainers: true,
				waitForExit: true,
				onAppExit: (_name, code) => exits.push(code),
			},
		);
		expect(exits).toEqual([0]);
	});
});

describe("startDevServers essential: false", () => {
	it("keeps the run going when a non-essential app fails, and restarts it on request", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-optional-"));
		const marker = join(root, "ran-once");
		const output = new RunOutput();
		output.terminalSize = () => ({ cols: 80, rows: 10 });
		const states: string[] = [];
		output.subscribe({
			state: (app, { state }) => states.push(`${app}:${state}`),
		});
		const flaky = `bun -e ${JSON.stringify(
			`const f = ${JSON.stringify(marker)}; if (!(await Bun.file(f).exists())) { await Bun.write(f, "1"); console.log("build error: boom"); process.exit(1); } console.log("tty", process.stdout.isTTY); setInterval(() => {}, 60000);`,
		)}`;
		let pids: Record<string, number> = {};
		const until = async (check: () => boolean) => {
			for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(25);
			expect(check()).toBe(true);
		};
		try {
			pids = await startDevServers(
				{
					keeper: {
						kind: "worker",
						devCommand: "bun -e 'setInterval(() => {}, 60000)'",
					},
					flaky: { kind: "worker", essential: false, devCommand: flaky },
				},
				root,
				{},
				{},
				{ verbose: false, waitForExit: false, output },
			);
			await until(() => states.includes("flaky:failed"));
			expect(output.tail("flaky")).toContain("build error: boom");
			expect(processExists(pids.keeper)).toBe(true);

			await output.controls?.restart("flaky");
			await until(() => output.tail("flaky").includes("tty true"));
			await until(() => output.states.get("flaky")?.state === "ready");
			expect(processExists(pids.keeper)).toBe(true);
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("startDevServers non-essential crash on start", () => {
	it("reports a worker that dies while it is being claimed, and keeps the run", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-optional-crash-"));
		const output = new RunOutput();
		let pids: Record<string, number> = {};
		try {
			pids = await startDevServers(
				{
					keeper: {
						kind: "worker",
						devCommand: "bun -e 'setInterval(() => {}, 60000)'",
					},
					// Gone before its birth identity can be read.
					crash: { kind: "worker", essential: false, devCommand: "exit 3" },
				},
				root,
				{},
				{},
				{ verbose: false, waitForExit: false, output },
			);
			for (let i = 0; i < 100 && !output.states.get("crash"); i++)
				await Bun.sleep(20);
			for (
				let i = 0;
				i < 100 && output.states.get("crash")?.state !== "failed";
				i++
			)
				await Bun.sleep(20);
			expect(output.states.get("crash")).toMatchObject({
				state: "failed",
				detail: "exit 3",
			});
			expect(processExists(pids.keeper)).toBe(true);
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("startDevServers non-essential crash under a terminal", () => {
	it("never reports a worker ready once its exit has been seen", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-optional-pty-"));
		// A slow `ps`: on macOS the worker is gone before its birth identity is
		// read, the path that used to report it ready. Linux reads /proc, so
		// there it may still be alive when claimed, and then ready is true.
		const bin = join(root, "bin");
		await mkdir(bin);
		await writeFile(
			join(bin, "ps"),
			`#!/bin/sh\nsleep 0.3\nexec /bin/ps "$@"\n`,
			{ mode: 0o755 },
		);
		const path = process.env.PATH;
		process.env.PATH = `${bin}:${path}`;
		const output = new RunOutput();
		output.terminalSize = () => ({ cols: 80, rows: 10 });
		const states: string[] = [];
		output.subscribe({
			state: (app, { state }) => states.push(`${app}:${state}`),
		});
		const events: string[] = [];
		let pids: Record<string, number> = {};
		try {
			pids = await startDevServers(
				{
					keeper: {
						kind: "worker",
						devCommand: "bun -e 'setInterval(() => {}, 60000)'",
					},
					crash: { kind: "worker", essential: false, devCommand: "exit 3" },
				},
				root,
				{},
				{},
				{
					verbose: false,
					waitForExit: false,
					output,
					onAppReady: (name) => events.push(`ready:${name}`),
					onAppExit: (name) => events.push(`exit:${name}`),
				},
			);
			for (
				let i = 0;
				i < 100 && output.states.get("crash")?.state !== "failed";
				i++
			)
				await Bun.sleep(20);
			expect(output.states.get("crash")?.state).toBe("failed");
			// Ready, if at all, only while the process was still alive.
			const exit = events.indexOf("exit:crash");
			expect(exit).toBeGreaterThan(-1);
			expect(events.slice(exit)).not.toContain("ready:crash");
		} finally {
			process.env.PATH = path;
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("startDevServers non-essential readiness", () => {
	it("never reports an app ready after it has exited", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-optional-ready-"));
		// flaky exits only once its health check has begun. Exiting at once, it
		// can be gone before its birth identity is read (a slow `ps` on macOS),
		// and then no check starts at all: nothing would finish after the exit.
		const exitNow = join(root, "exit-now");
		const output = new RunOutput();
		const ready: string[] = [];
		const flakyExited = Promise.withResolvers<void>();
		const flakyChecked = Promise.withResolvers<void>();
		let pids: Record<string, number> = {};
		try {
			pids = await startDevServers(
				{
					keeper: {
						kind: "worker",
						devCommand: "bun -e 'setInterval(() => {}, 60000)'",
					},
					flaky: {
						kind: "worker",
						essential: false,
						devCommand: `bun -e ${JSON.stringify(`setInterval(() => { if (require("node:fs").existsSync(${JSON.stringify(exitNow)})) process.exit(1); }, 10)`)}`,
					},
				},
				root,
				{},
				{},
				{
					verbose: false,
					waitForExit: false,
					output,
					onAppReady: (name) => ready.push(name),
					onAppExit: (name) => {
						if (name === "flaky") flakyExited.resolve();
					},
					// A slow check: it finishes after flaky is already gone.
					waitForHealth: async (wave, signal) => {
						if (!("flaky" in wave)) return;
						try {
							await writeFile(exitNow, "");
							await flakyExited.promise;
							signal?.throwIfAborted();
						} finally {
							flakyChecked.resolve();
						}
					},
				},
			);
			await flakyChecked.promise;
			// Whatever the finished check would report runs before the next turn.
			await new Promise((resolve) => setImmediate(resolve));
			expect(output.states.get("flaky")?.state).toBe("failed");
			expect(ready).not.toContain("flaky");
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	});
});

function processExists(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("startDevServers prebuild", () => {
	it("has stopped an aborted prebuild by the time it rejects", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-prebuild-abort-"));
		const output = new RunOutput();
		const controller = new AbortController();
		const { promise: prebuildPid, resolve } = Promise.withResolvers<number>();
		output.subscribe({
			line: (line) => {
				const match = /^prebuild (\d+)$/.exec(line.text);
				if (match) resolve(Number(match[1]));
			},
		});
		try {
			const run = startDevServers(
				{
					api: {
						kind: "worker",
						// Ignores SIGTERM: only the escalation stops it.
						prebuild: `trap "" TERM; echo prebuild $$; exec sleep 30`,
						devCommand: "bun -e 'setInterval(() => {}, 60000)'",
					},
				},
				root,
				{},
				{},
				{
					verbose: false,
					waitForExit: false,
					output,
					signal: controller.signal,
					shutdownGraceMs: 200,
				},
			);
			void run.catch(() => {});
			const pid = await prebuildPid;
			controller.abort();
			await expect(run).rejects.toThrow();
			expect(processExists(pid)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("startDevServers restart", () => {
	const silent = "bun -e 'setInterval(() => {}, 60000)'";

	it("parks an app a restart could not replace, until a restart brings it back", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-restart-failed-"));
		await mkdir(join(root, "api"));
		const output = new RunOutput();
		const restartFailures: string[] = [];
		const failures: unknown[] = [];
		let pids: Record<string, number> = {};
		try {
			pids = await startDevServers(
				{
					keeper: { kind: "worker", devCommand: silent },
					api: { kind: "worker", cwd: "api", devCommand: silent },
				},
				root,
				{},
				{},
				{
					verbose: false,
					waitForExit: false,
					output,
					keepOthersOnFailure: true,
					onAppRestartFailed: (name) => restartFailures.push(name),
					onFailure: (error) => failures.push(error),
				},
			);
			// Its working directory is gone: the replacement cannot spawn.
			await rm(join(root, "api"), { recursive: true });
			await expect(output.controls?.restart("api")).rejects.toThrow();
			expect(output.states.get("api")).toMatchObject({
				state: "failed",
				restartable: true,
			});
			// What the CLI marks `failed` in the run registry.
			expect(restartFailures).toEqual(["api"]);

			await mkdir(join(root, "api"));
			await output.controls?.restart("api");
			await eventually(() => output.states.get("api")?.state === "ready");
			expect(processExists(pids.keeper)).toBe(true);
			expect(failures).toEqual([]);
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails the run when a restart cannot replace an essential app", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-restart-ends-"));
		await mkdir(join(root, "api"));
		const failures: string[] = [];
		let pids: Record<string, number> = {};
		try {
			const output = new RunOutput();
			pids = await startDevServers(
				{
					keeper: { kind: "worker", devCommand: silent },
					api: { kind: "worker", cwd: "api", devCommand: silent },
				},
				root,
				{},
				{},
				{
					verbose: false,
					waitForExit: false,
					output,
					onFailure: (error) => failures.push(toError(error).message),
				},
			);
			await rm(join(root, "api"), { recursive: true });
			await expect(output.controls?.restart("api")).rejects.toThrow();
			// Not a run left waiting on an app that is gone.
			await eventually(() => failures.length > 0);
			expect(failures[0]).toContain('App "api" could not be restarted');
			await eventually(() => !processExists(pids.keeper));
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("leaves the row of an app as it was when the run has ended", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-restart-ended-"));
		const output = new RunOutput();
		let pids: Record<string, number> = {};
		try {
			pids = await startDevServers(
				{ api: { kind: "worker", devCommand: silent } },
				root,
				{},
				{},
				{ verbose: false, waitForExit: false, output },
			);
			expect(output.states.get("api")?.state).toBe("ready");
			await stopDevServers(pids);
			await output.controls?.restart("api");
			expect(output.states.get("api")?.state).toBe("ready");
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("never lets a late exit report land on the process that replaced it", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-restart-late-"));
		const marker = join(root, "ran-once");
		const output = new RunOutput();
		// An exit is shown once the app's screen has drawn its last words.
		// This one takes until the replacement has spawned.
		const replaced = Promise.withResolvers<void>();
		const screen = output.screen("flaky");
		const drawn = screen.flush.bind(screen);
		screen.flush = () => replaced.promise.then(drawn);
		const flaky = `bun -e ${JSON.stringify(
			`const f = ${JSON.stringify(marker)}; if (!(await Bun.file(f).exists())) { await Bun.write(f, "1"); process.exit(1); } setInterval(() => {}, 60000);`,
		)}`;
		const port = await freePort();
		let spawns = 0;
		let pids: Record<string, number> = {};
		try {
			pids = await startDevServers(
				{
					keeper: { kind: "worker", devCommand: silent },
					flaky: {
						port,
						essential: false,
						healthEndpoint: false,
						devCommand: flaky,
					},
				},
				root,
				{},
				{ flaky: port },
				{
					verbose: false,
					waitForExit: false,
					output,
					// Restarted the moment its exit is seen, before it is shown.
					onAppExit: (name) => {
						if (name === "flaky") void output.controls?.restart("flaky");
					},
					onAppSpawned: (name) => {
						if (name === "flaky" && ++spawns === 2) replaced.resolve();
					},
				},
			);
			await replaced.promise;
			// The old process's exit has been shown, or dropped, by now.
			await screen.flush();
			await eventually(() => output.states.get("flaky")?.state === "ready");
			await screen.flush();
			expect(output.states.get("flaky")?.state).toBe("ready");
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);
});

describe("startDevServers keepOthersOnFailure", () => {
	const serve = (port: number) =>
		`bun -e 'Bun.serve({ port: ${port}, fetch: () => new Response("ok") }); setInterval(() => {}, 60000)'`;
	const silent = "bun -e 'setInterval(() => {}, 60000)'";

	it("stops the app that never came up and keeps the healthy one", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-keep-others-"));
		const api = await freePort();
		const marketing = api + 1;
		const output = new RunOutput();
		output.terminalSize = () => ({ cols: 80, rows: 10 });
		const failed: string[] = [];
		let pids: Record<string, number> = {};
		try {
			pids = await startDevServers(
				{
					api: { port: api, devCommand: serve(api) },
					marketing: {
						port: marketing,
						healthTimeout: 500,
						devCommand: silent,
					},
				},
				root,
				{},
				{ api, marketing },
				{
					verbose: false,
					waitForExit: false,
					output,
					keepOthersOnFailure: true,
					onAppFailed: (name) => failed.push(name),
				},
			);
			expect(failed).toEqual(["marketing"]);
			expect(processExists(pids.api)).toBe(true);
			for (
				let i = 0;
				i < 100 && output.states.get("marketing")?.state !== "failed";
				i++
			)
				await Bun.sleep(20);
			expect(output.states.get("marketing")?.state).toBe("failed");
			expect(output.states.get("marketing")?.restartable).toBe(true);
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	}, 15000);

	it("still fails the run when nothing came up, or a later app waits on it", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-keep-others-"));
		const port = await freePort();
		try {
			await expect(
				startDevServers(
					{ only: { port, healthTimeout: 300, devCommand: silent } },
					root,
					{},
					{ only: port },
					{ verbose: false, waitForExit: false, keepOthersOnFailure: true },
				),
			).rejects.toThrow("did not respond");

			await expect(
				startDevServers(
					{
						base: { port, healthTimeout: 300, devCommand: silent },
						next: {
							port: port + 1,
							startAfter: ["base"],
							devCommand: serve(port + 1),
						},
					},
					root,
					{},
					{ base: port, next: port + 1 },
					{ verbose: false, waitForExit: false, keepOthersOnFailure: true },
				),
			).rejects.toThrow("next starts after base");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 15000);

	it("parks an app that crashes at boot, and a restart that brings it up makes it essential again", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-keep-others-crash-"));
		const [api, web] = await freePorts(2);
		const marker = join(root, "ran-once");
		// Crashes the first time, serves the second.
		const crashOnce = `bun -e ${JSON.stringify(
			`const f = ${JSON.stringify(marker)}; if (!(await Bun.file(f).exists())) { await Bun.write(f, "1"); process.exit(1); } Bun.serve({ port: ${web}, fetch: () => new Response("ok") }); setInterval(() => {}, 60000);`,
		)}`;
		const output = new RunOutput();
		const failed: string[] = [];
		const runFailures: string[] = [];
		let pids: Record<string, number> = {};
		try {
			pids = await startDevServers(
				{
					api: { port: api, devCommand: serve(api) },
					web: { port: web, devCommand: crashOnce },
				},
				root,
				{},
				{ api, web },
				{
					verbose: false,
					waitForExit: false,
					output,
					keepOthersOnFailure: true,
					onAppFailed: (name) => failed.push(name),
					onFailure: (error) => runFailures.push(toError(error).message),
				},
			);
			expect(failed).toEqual(["web"]);
			expect(processExists(pids.api)).toBe(true);
			await eventually(() => output.states.get("web")?.restartable === true);
			expect(output.states.get("web")?.state).toBe("failed");

			await output.controls?.restart("web");
			await eventually(() => output.states.get("web")?.state === "ready");
			expect(runFailures).toEqual([]);

			// Up again, so its falling over is the run's end like any essential app's.
			signalProcessTree(pids.web, "SIGKILL");
			await eventually(() => runFailures.length > 0);
			expect(runFailures[0]).toContain('App "web" exited');
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);

	it("makes an app parked for never answering essential again once a restart brings it up", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-keep-others-unpark-"));
		const [api, web] = await freePorts(2);
		const marker = join(root, "ran-once");
		// Silent the first time, serves the second.
		const silentOnce = `bun -e ${JSON.stringify(
			`const f = ${JSON.stringify(marker)}; if (!(await Bun.file(f).exists())) { await Bun.write(f, "1"); } else Bun.serve({ port: ${web}, fetch: () => new Response("ok") }); setInterval(() => {}, 60000);`,
		)}`;
		const output = new RunOutput();
		const runFailures: string[] = [];
		let pids: Record<string, number> = {};
		try {
			pids = await startDevServers(
				{
					api: { port: api, devCommand: serve(api) },
					web: { port: web, healthTimeout: 300, devCommand: silentOnce },
				},
				root,
				{},
				{ api, web },
				{
					verbose: false,
					waitForExit: false,
					output,
					keepOthersOnFailure: true,
					onFailure: (error) => runFailures.push(toError(error).message),
				},
			);
			await eventually(() => output.states.get("web")?.state === "failed");
			await output.controls?.restart("web");
			await eventually(() => output.states.get("web")?.state === "ready");

			signalProcessTree(pids.web, "SIGKILL");
			await eventually(() => runFailures.length > 0);
			expect(runFailures[0]).toContain('App "web" exited');
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);
});

describe("startDevServers apps that never come up", () => {
	const serve = (port: number) =>
		`bun -e 'Bun.serve({ port: ${port}, fetch: () => new Response("ok") }); setInterval(() => {}, 60000)'`;
	const silent = "bun -e 'setInterval(() => {}, 60000)'";

	it("stops a non-essential app that never answers and says why", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-side-failed-"));
		const port = await freePort();
		const output = new RunOutput();
		const failed: string[] = [];
		let pids: Record<string, number> = {};
		try {
			pids = await startDevServers(
				{
					keeper: { kind: "worker", devCommand: silent },
					side: {
						port,
						essential: false,
						healthTimeout: 300,
						devCommand: silent,
					},
				},
				root,
				{},
				{ side: port },
				{
					verbose: false,
					waitForExit: false,
					output,
					onAppFailed: (name) => failed.push(name),
				},
			);
			const side = pids.side;
			await eventually(() => output.states.get("side")?.state === "failed");
			expect(output.states.get("side")).toMatchObject({
				detail: expect.stringContaining("did not respond"),
				restartable: true,
			});
			await eventually(() => failed.includes("side"));
			expect(failed).toEqual(["side"]);
			expect(processExists(side)).toBe(false);
			expect(processExists(pids.keeper)).toBe(true);
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("brings a reused app's row up, and leaves it running when it fails its check", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-reused-"));
		const [api, web, admin] = await freePorts(3);
		// This project's containers serve web and admin; only web answers.
		const container = Bun.serve({ port: web, fetch: () => new Response("ok") });
		const runtime = {
			name: "docker",
			containerPortOwnersAsync: async () =>
				new Map([
					[web, { id: "w", name: "proj-web-1", composeProject: "proj" }],
					[admin, { id: "a", name: "proj-admin-1", composeProject: "proj" }],
				]),
		} as unknown as ContainerRuntimeAdapter;
		const output = new RunOutput();
		const failed: string[] = [];
		const ready: string[] = [];
		let pids: Record<string, number> = {};
		try {
			pids = await startDevServers(
				{
					api: { port: api, devCommand: serve(api) },
					web: { port: web, devCommand: serve(web) },
					admin: { port: admin, healthTimeout: 300, devCommand: serve(admin) },
				},
				root,
				{},
				{ api, web, admin },
				{
					verbose: false,
					waitForExit: false,
					output,
					runtime,
					projectName: "proj",
					portDrift: false,
					keepOthersOnFailure: true,
					onAppFailed: (name) => failed.push(name),
					onAppReady: (name) => ready.push(name),
				},
			);
			expect(pids.web).toBeUndefined();
			expect(output.states.get("web")?.state).toBe("ready");
			expect(ready).toContain("web");
			expect(failed).toEqual(["admin"]);
			expect(output.states.get("admin")).toMatchObject({
				state: "failed",
				restartable: false,
				detail: expect.stringContaining("left running"),
			});
		} finally {
			await stopDevServers(pids);
			container.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);

	it("refuses to start an app whose leftover process will not let go of its port", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-port-held-"));
		const port = await freePort();
		const leftoverPid = join(root, "leftover.pid");
		const successorPid = join(root, "successor.pid");
		// A leftover of this checkout that, asked to stop, hands its port to a
		// successor no SIGKILL of the leftover reaches.
		await Bun.write(
			join(root, "successor.ts"),
			`Bun.serve({ port: ${port}, reusePort: true, fetch: () => new Response("successor") }); await Bun.write(${JSON.stringify(successorPid)}, String(process.pid)); setInterval(() => {}, 60000);`,
		);
		await Bun.write(
			join(root, "leftover.ts"),
			`import { spawn } from "node:child_process"; Bun.serve({ port: ${port}, reusePort: true, fetch: () => new Response("leftover") }); process.on("SIGTERM", async () => { spawn(process.execPath, ["successor.ts"], { cwd: ${JSON.stringify(root)}, detached: true, stdio: "ignore" }).unref(); while (!(await Bun.file(${JSON.stringify(successorPid)}).exists())) await Bun.sleep(10); process.exit(0); }); await Bun.write(${JSON.stringify(leftoverPid)}, String(process.pid)); setInterval(() => {}, 60000);`,
		);
		const leftover = Bun.spawn([process.execPath, "leftover.ts"], {
			cwd: root,
			stdio: ["ignore", "ignore", "ignore"],
		});
		const spawned: string[] = [];
		try {
			const deadline = Date.now() + 5000;
			while (!(await Bun.file(leftoverPid).exists()) && Date.now() < deadline)
				await Bun.sleep(20);
			await expect(
				startDevServers(
					{ web: { port, stopGraceMs: 300, devCommand: serve(port) } },
					root,
					{},
					{ web: port },
					{
						verbose: false,
						waitForExit: false,
						skipContainers: true,
						onAppSpawned: (name) => spawned.push(name),
					},
				),
			).rejects.toThrow("did not stop");
			expect(spawned).toEqual([]);
		} finally {
			leftover.kill("SIGKILL");
			if (await Bun.file(successorPid).exists()) {
				const successor = Number(await Bun.file(successorPid).text());
				if (processExists(successor)) process.kill(successor, "SIGKILL");
			}
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);
});

describe("startDevServers readyWhen and interactive apps without a terminal", () => {
	it("waits for the line the app prints, and fails when it never comes", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-ready-when-"));
		const port = await freePort();
		let pids: Record<string, number> = {};
		try {
			// Nothing listens on the port: only the printed line can make it ready.
			const started = performance.now();
			pids = await startDevServers(
				{
					metro: {
						port,
						readyWhen: /Logs for your project/,
						devCommand: `bun -e 'setTimeout(() => console.log("Logs for your project will appear below."), 300); setInterval(() => {}, 60000)'`,
					},
				},
				root,
				{},
				{ metro: port },
				{ verbose: false, waitForExit: false },
			);
			expect(performance.now() - started).toBeGreaterThan(250);
			await stopDevServers(pids);
			pids = {};

			await expect(
				startDevServers(
					{
						metro: {
							port,
							readyWhen: /Logs for your project/,
							healthTimeout: 400,
							devCommand: "bun -e 'setInterval(() => {}, 60000)'",
						},
					},
					root,
					{},
					{ metro: port },
					{ verbose: false, waitForExit: false },
				),
			).rejects.toThrow("metro did not print /Logs for your project/");
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	}, 15000);

	it("gives an interactive app a terminal of its own, and types into it", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-headless-tty-"));
		const output = new RunOutput();
		const lines: string[] = [];
		output.subscribe({ line: (line) => lines.push(line.text) });
		let pids: Record<string, number> = {};
		const until = async (check: () => boolean) => {
			for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(25);
			expect(check()).toBe(true);
		};
		try {
			pids = await startDevServers(
				{
					expo: {
						kind: "worker",
						interactive: true,
						devCommand: `bun -e 'console.log("tty", Boolean(process.stdin.isTTY)); process.stdin.setRawMode(true); process.stdin.on("data", (d) => console.log("key", String(d)))'`,
					},
				},
				root,
				{},
				{},
				{ verbose: false, waitForExit: false, output },
			);
			await until(() => lines.includes("tty true"));
			output.screens.get("expo")?.input("i");
			await until(() => lines.includes("key i"));
		} finally {
			await stopDevServers(pids);
			await rm(root, { recursive: true, force: true });
		}
	}, 15000);
});
