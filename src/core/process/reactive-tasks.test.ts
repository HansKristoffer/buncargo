import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevEnvironment, internalsOf } from "../../environment";
import { freePorts, useTempHome } from "../test-env.testing";
import { AppLogs } from "./app-logs";
import { ReactiveTaskRunner, selectReactiveTasks } from "./reactive-tasks";
import { type AppStateDetail, RunOutput } from "./run-output";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function makeTempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

async function until(
	condition: () => boolean,
	timeoutMs = 10_000,
	label = "condition",
): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!condition()) {
		if (performance.now() > deadline) {
			throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) {
		await fn();
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("reactive task selection", () => {
	it("activates reactive tasks only when their required apps, owning app, and services are selected", () => {
		const tasks = {
			manual: { command: "bun seed.ts" },
			emptyTrigger: { command: "bun empty.ts", onAppReady: [] },
			genApi: { command: "bun gen-api.ts", onAppReady: ["api"] },
			genBoth: { command: "bun gen-both.ts", onAppReady: ["api", "auth"] },
			genWeb: {
				command: "bun gen-web.ts",
				app: "web",
				watch: { paths: ["src"] },
			},
			genSchemas: { command: "bun gen-schemas.ts", watch: { paths: ["spec"] } },
			genDb: {
				command: "bun gen-db.ts",
				requiredServices: ["postgres"],
				watch: { paths: ["prisma"] },
			},
		};

		expect(Object.keys(selectReactiveTasks(tasks, new Set(["api"])))).toEqual([
			"genApi",
			"genSchemas",
			"genDb",
		]);
		expect(
			Object.keys(selectReactiveTasks(tasks, new Set(["api"]), new Set())),
		).toEqual(["genApi", "genSchemas"]);
		expect(
			Object.keys(
				selectReactiveTasks(tasks, new Set(["api"]), new Set(["postgres"])),
			),
		).toEqual(["genApi", "genSchemas", "genDb"]);
		expect(
			Object.keys(selectReactiveTasks(tasks, new Set(["api", "auth", "web"]))),
		).toEqual(["genApi", "genBoth", "genWeb", "genSchemas", "genDb"]);
		expect(
			Object.keys(selectReactiveTasks(tasks, new Set(), new Set())),
		).toEqual(["genSchemas"]);
	});
});

describe("ReactiveTaskRunner", () => {
	it("waits for every onAppReady app, passes fresh env, and re-runs after restarts", async () => {
		const root = makeTempDir("buncargo-reactive-ready-");
		const outFile = join(root, "runs.log");
		const output = new RunOutput({ terminals: "pipe" });
		const controller = new AbortController();
		const states: AppStateDetail[] = [];
		output.subscribe({
			state: (name, detail) => {
				if (name === "gen") states.push(detail);
			},
		});

		let version = 1;
		const runner = new ReactiveTaskRunner({
			root,
			apps: {},
			tasks: {
				gen: {
					command: `${JSON.stringify(process.execPath)} -e 'require("node:fs").appendFileSync(${JSON.stringify(outFile)}, process.env.API_LOOPBACK_URL + "|" + process.env.GEN_VERSION + "\\n")'`,
					onAppReady: ["api", "auth"],
				},
			},
			buildEnv: () => ({
				API_LOOPBACK_URL: "http://localhost:41234",
				GEN_VERSION: `v${version}`,
			}),
			output,
			signal: controller.signal,
		});
		cleanups.push(async () => {
			controller.abort();
			await runner.stop();
			await output.close();
		});

		expect(output.states.get("gen")).toMatchObject({
			state: "stopped",
			detail: "idle",
			restartable: false,
			rerunCommand: "buncargo run gen",
		});

		// Only one of two prerequisite apps ready: task stays idle.
		runner.onAppPhase("api", "ready", "starting");
		expect(existsSync(outFile)).toBe(false);
		expect(output.states.get("gen")?.detail).toBe("idle");

		// Second prerequisite becomes ready -> initial run fires.
		runner.onAppPhase("auth", "ready", "starting");
		await until(
			() => output.states.get("gen")?.state === "ready",
			5_000,
			"initial run",
		);
		expect(readFileSync(outFile, "utf8").trim().split("\n")).toEqual([
			"http://localhost:41234|v1",
		]);
		expect(output.states.get("gen")?.detail).toBe("ok");

		// api restarts -> once ready again, gen re-runs with fresh env.
		version = 2;
		runner.onAppPhase("api", "restarting", "ready");
		runner.onAppPhase("api", "starting", "restarting");
		runner.onAppPhase("api", "ready", "starting");
		await until(
			() => readFileSync(outFile, "utf8").trim().split("\n").length === 2,
			5_000,
			"restart re-run",
		);
		await until(
			() => output.states.get("gen")?.state === "ready",
			5_000,
			"settled after restart",
		);
		expect(readFileSync(outFile, "utf8").trim().split("\n")).toEqual([
			"http://localhost:41234|v1",
			"http://localhost:41234|v2",
		]);
		expect(
			states.some((s) => s.state === "starting" && s.detail === "running"),
		).toBe(true);
	});

	it("coalesces overlapping triggers to single-flight plus at most one follow-up run", async () => {
		const root = makeTempDir("buncargo-reactive-coalesce-");
		const startedFile = join(root, "started.log");
		const gateFile = join(root, "gate");
		const activeLockFile = join(root, "active");
		const overlapFile = join(root, "overlap");
		const script = join(root, "gen.ts");
		writeFileSync(
			script,
			`import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
if (existsSync(${JSON.stringify(activeLockFile)})) writeFileSync(${JSON.stringify(overlapFile)}, "overlap");
writeFileSync(${JSON.stringify(activeLockFile)}, String(process.pid));
appendFileSync(${JSON.stringify(startedFile)}, "run\\n");
while (!existsSync(${JSON.stringify(gateFile)})) {
	await new Promise((r) => setTimeout(r, 10));
}
unlinkSync(${JSON.stringify(activeLockFile)});
`,
		);

		const output = new RunOutput({ terminals: "pipe" });
		const controller = new AbortController();
		const runner = new ReactiveTaskRunner({
			root,
			apps: {},
			tasks: {
				gen: {
					command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
					onAppReady: ["api"],
				},
			},
			buildEnv: () => ({}),
			output,
			signal: controller.signal,
		});
		cleanups.push(async () => {
			controller.abort();
			await runner.stop();
			await output.close();
		});

		expect(runner.trigger("gen", "first")).toBe(true);
		await until(() => existsSync(startedFile), 5_000, "first run started");

		// Fire four rapid triggers while run #1 is still blocked on gateFile.
		runner.trigger("gen", "second");
		runner.trigger("gen", "third");
		runner.trigger("gen", "fourth");
		runner.trigger("gen", "fifth");

		// Release gate so run #1 finishes and the single coalesced follow-up runs.
		writeFileSync(gateFile, "go");
		await until(
			() =>
				output.states.get("gen")?.state === "ready" &&
				readFileSync(startedFile, "utf8").trim().split("\n").length >= 2,
			5_000,
			"coalesced follow-up finished",
		);

		await runner.stop();
		expect(readFileSync(startedFile, "utf8").trim().split("\n")).toHaveLength(
			2,
		);
		expect(existsSync(overlapFile)).toBe(false);
	});

	it("handles failure non-fatally, writes task logs, and recovers on the next trigger", async () => {
		const root = makeTempDir("buncargo-reactive-fail-");
		const okFlag = join(root, "should-pass");
		const logs = new AppLogs(root, "test-run");
		const output = new RunOutput({ terminals: "pipe", logs });
		const controller = new AbortController();

		const runner = new ReactiveTaskRunner({
			root,
			apps: {},
			tasks: {
				gen: {
					command: `${JSON.stringify(process.execPath)} -e 'const ok = require("node:fs").existsSync(${JSON.stringify(okFlag)}); if (!ok) { console.error("syntax boom"); process.exit(2); } console.log("generated ok");'`,
					onAppReady: ["api"],
				},
			},
			buildEnv: () => ({}),
			output,
			signal: controller.signal,
		});
		cleanups.push(async () => {
			controller.abort();
			await runner.stop();
			await output.close();
		});

		runner.trigger("gen", "initial");
		await until(
			() => output.states.get("gen")?.state === "failed",
			5_000,
			"non-fatal failure",
		);
		expect(output.states.get("gen")).toMatchObject({
			state: "failed",
			detail: "exit 2",
			restartable: true,
			rerunCommand: "buncargo run gen",
		});
		expect(controller.signal.aborted).toBe(false);

		// Fix the error and re-trigger -> recovers cleanly to ready/ok.
		writeFileSync(okFlag, "1");
		runner.trigger("gen", "retry");
		await until(
			() => output.states.get("gen")?.state === "ready",
			5_000,
			"recovery run",
		);
		expect(output.states.get("gen")?.detail).toBe("ok");

		await output.close();
		const logText = readFileSync(logs.file("gen"), "utf8");
		expect(logText).toContain("syntax boom");
		expect(logText).toContain("generated ok");
	});

	it("runs finite file-watched tasks on change, respects ignore, and honors --no-watch", async () => {
		const root = makeTempDir("buncargo-reactive-watch-");
		mkdirSync(join(root, "schemas"), { recursive: true });
		mkdirSync(join(root, "schemas/ignored"), { recursive: true });
		const countFile = join(root, "count.log");
		const output = new RunOutput({ terminals: "pipe" });
		const controller = new AbortController();

		const runner = new ReactiveTaskRunner({
			root,
			apps: {},
			tasks: {
				gen: {
					command: `${JSON.stringify(process.execPath)} -e 'require("node:fs").appendFileSync(${JSON.stringify(countFile)}, "tick\\n")'`,
					watch: {
						paths: ["schemas"],
						ignore: ["**/ignored/**"],
						debounceMs: 40,
					},
				},
			},
			buildEnv: () => ({}),
			output,
			signal: controller.signal,
		});
		cleanups.push(async () => {
			controller.abort();
			await runner.stop();
			await output.close();
		});

		runner.arm();
		// Let macOS FSEvents attach the recursive watch stream before writing.
		await Bun.sleep(150);
		writeFileSync(join(root, "schemas/ignored/skip.yaml"), "a: 1\n");
		writeFileSync(join(root, "schemas/openapi.yaml"), "openapi: 3.1.0\n");

		await until(
			() =>
				existsSync(countFile) && output.states.get("gen")?.state === "ready",
			10_000,
			"watch triggered finite run",
		);
		expect(output.states.get("gen")?.detail).toBe("ok");
		expect(readFileSync(countFile, "utf8").trim().split("\n")).toEqual([
			"tick",
		]);

		// With watch: false (--no-watch), file edits do not trigger, manual trigger still works.
		const noWatchRoot = makeTempDir("buncargo-reactive-nowatch-");
		mkdirSync(join(noWatchRoot, "schemas"), { recursive: true });
		const noWatchCount = join(noWatchRoot, "count.log");
		const noWatchOut = new RunOutput({ terminals: "pipe" });
		const noWatchCtrl = new AbortController();
		const noWatchRunner = new ReactiveTaskRunner({
			root: noWatchRoot,
			apps: {},
			tasks: {
				gen: {
					command: `${JSON.stringify(process.execPath)} -e 'require("node:fs").appendFileSync(${JSON.stringify(noWatchCount)}, "tick\\n")'`,
					watch: { paths: ["schemas"], debounceMs: 20 },
				},
			},
			buildEnv: () => ({}),
			output: noWatchOut,
			signal: noWatchCtrl.signal,
			watch: false,
		});
		cleanups.push(async () => {
			noWatchCtrl.abort();
			await noWatchRunner.stop();
			await noWatchOut.close();
		});

		noWatchRunner.arm();
		writeFileSync(join(noWatchRoot, "schemas/openapi.yaml"), "changed\n");
		noWatchRunner.trigger("gen", "requested");
		await until(
			() => noWatchOut.states.get("gen")?.state === "ready",
			5_000,
			"manual run under --no-watch",
		);
		expect(readFileSync(noWatchCount, "utf8").trim().split("\n")).toEqual([
			"tick",
		]);
	}, 15_000);

	it("aborts in-flight buildEnv on stop() without spawning a child, and resolves reused task.app cwd", async () => {
		const root = makeTempDir("buncargo-reactive-stop-");
		mkdirSync(join(root, "apps/api"), { recursive: true });
		const spawnedFile = join(root, "should-not-exist");
		const cwdFile = join(root, "cwd.txt");
		const output = new RunOutput({ terminals: "pipe" });
		const controller = new AbortController();

		let envStarted = false;
		const stopRunner = new ReactiveTaskRunner({
			root,
			apps: { api: { cwd: "apps/api" } },
			tasks: {
				gen: {
					command: `${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync(${JSON.stringify(spawnedFile)}, "spawned")'`,
					onAppReady: ["api"],
				},
			},
			buildEnv: (_task, signal) =>
				new Promise<Record<string, string>>((_resolve, reject) => {
					envStarted = true;
					signal.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				}),
			output,
			signal: controller.signal,
		});
		cleanups.push(async () => {
			controller.abort();
			await stopRunner.stop();
			await output.close();
		});

		stopRunner.trigger("gen", "requested");
		await until(() => envStarted, 5_000, "buildEnv started");
		// Calling stop() even when external controller.signal is NOT aborted cancels buildEnv and spawns nothing.
		await stopRunner.stop();
		expect(existsSync(spawnedFile)).toBe(false);

		// Reused app (`initialReadyApps`) resolves `task.app`'s `cwd` on `arm()`.
		const reusedOut = new RunOutput({ terminals: "pipe" });
		const reusedCtrl = new AbortController();
		const reusedRunner = new ReactiveTaskRunner({
			root,
			apps: { api: { cwd: "apps/api" } },
			tasks: {
				gen: {
					command: `${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync(${JSON.stringify(cwdFile)}, process.cwd())'`,
					app: "api",
					onAppReady: ["api"],
				},
			},
			buildEnv: () => ({}),
			output: reusedOut,
			signal: reusedCtrl.signal,
			initialReadyApps: ["api"],
		});
		cleanups.push(async () => {
			reusedCtrl.abort();
			await reusedRunner.stop();
			await reusedOut.close();
		});

		reusedRunner.arm();
		await until(
			() =>
				existsSync(cwdFile) && reusedOut.states.get("gen")?.state === "ready",
			5_000,
			"reused app cwd task",
		);
		expect(readFileSync(cwdFile, "utf8")).toBe(join(root, "apps/api"));
	});
});

describe("ReactiveTaskRunner end-to-end with live HTTP app", () => {
	useTempHome();

	it("runs OpenAPI-style codegen on initial app boot, re-runs after app restart, and supports manual trigger", async () => {
		const root = makeTempDir("buncargo-reactive-e2e-");
		const [apiPort] = freePorts(1);
		const specVersionFile = join(root, "spec-version.txt");
		const generatedFile = join(root, "generated-client.txt");
		const serverScript = join(root, "server.ts");
		const genScript = join(root, "codegen.ts");

		writeFileSync(specVersionFile, "v1");
		writeFileSync(
			serverScript,
			`import { readFileSync } from "node:fs";
const port = Number(process.env.PORT);
const version = readFileSync(${JSON.stringify(specVersionFile)}, "utf8").trim();
Bun.serve({
	port,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/health") return new Response("ok");
		if (url.pathname === "/docs/yaml") return new Response("openapi: " + version);
		return new Response("not found", { status: 404 });
	},
});
`,
		);
		writeFileSync(
			genScript,
			`import { writeFileSync } from "node:fs";
const res = await fetch(process.env.API_LOOPBACK_URL + "/docs/yaml");
const yaml = await res.text();
writeFileSync(${JSON.stringify(generatedFile)}, yaml + "|" + process.env.MODE);
`,
		);

		const env = createDevEnvironment(
			{
				projectPrefix: "codegen",
				services: {},
				apps: {
					api: {
						port: apiPort,
						devCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(serverScript)}`,
						healthEndpoint: "/health",
					},
				},
				profiles: {
					local: {
						env: { MODE: "local-profile" },
					},
				},
				tasks: {
					"gen:client": {
						command: `${JSON.stringify(process.execPath)} ${JSON.stringify(genScript)}`,
						onAppReady: ["api"],
					},
				},
			},
			{ root, profile: "local" },
		);

		// 1. Verify library `env.start()` triggers codegen on boot.
		const startCtrl = new AbortController();
		cleanups.push(async () => {
			startCtrl.abort();
			await env.stop().catch(() => {});
		});
		const pids = await env.start({
			signal: startCtrl.signal,
			watchdog: false,
			verbose: false,
		});
		expect(pids?.api).toBeDefined();

		await until(
			() =>
				existsSync(generatedFile) &&
				readFileSync(generatedFile, "utf8") === "openapi: v1|local-profile",
			10_000,
			"initial codegen output",
		);

		startCtrl.abort();
		await env.stop();

		// 2. Verify stayOpen session re-runs codegen on app restart and supports TUI `r` trigger.
		const output = new RunOutput({ terminals: "pipe" });
		const stayCtrl = new AbortController();
		const internals = internalsOf(env);
		const prepared = await internals.prepare({
			signal: stayCtrl.signal,
			watchdog: false,
			verbose: false,
		});
		const claimed = await internals.claimApps(prepared, {
			signal: stayCtrl.signal,
		});

		writeFileSync(specVersionFile, "v2");
		const running = internals.spawn(claimed, {
			signal: stayCtrl.signal,
			output,
			stayOpen: (sig) =>
				new Promise<void>((resolve) => {
					if (sig.aborted) return resolve();
					sig.addEventListener("abort", () => resolve(), { once: true });
				}),
		});
		cleanups.push(async () => {
			stayCtrl.abort();
			await running.catch(() => {});
			await env.stop().catch(() => {});
			await output.close();
		});

		await until(
			() =>
				existsSync(generatedFile) &&
				readFileSync(generatedFile, "utf8") === "openapi: v2|local-profile",
			10_000,
			"initial stayOpen codegen output",
		);

		writeFileSync(specVersionFile, "v3");
		await output.controls?.restart("api");

		await until(
			() => readFileSync(generatedFile, "utf8") === "openapi: v3|local-profile",
			10_000,
			"post-restart codegen output",
		);

		rmSync(generatedFile, { force: true });
		const manual = await output.controls?.restart("gen:client");
		expect(manual).toBe(true);
		await until(
			() =>
				existsSync(generatedFile) &&
				readFileSync(generatedFile, "utf8") === "openapi: v3|local-profile",
			10_000,
			"manual task re-run",
		);

		stayCtrl.abort();
		await running.catch(() => {});
	});

	it("cancels a running reactive task via cancel() without failing or stopping the runner", async () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo-reactive-cancel-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const startedFile = join(root, "started");
		const output = new RunOutput({ terminals: "pipe" });
		const controller = new AbortController();
		const runner = new ReactiveTaskRunner({
			root,
			apps: {},
			tasks: {
				slow: {
					command: `${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync(${JSON.stringify(startedFile)}, String(process.pid)); setInterval(() => {}, 1000)'`,
					onAppReady: ["api"],
				},
			},
			buildEnv: () => ({}),
			output,
			signal: controller.signal,
			shutdownGraceMs: 200,
		});
		cleanups.push(async () => {
			controller.abort();
			await runner.stop();
		});

		expect(await runner.cancel("slow")).toBe(false);
		expect(runner.trigger("slow", "requested")).toBe(true);
		await until(() => existsSync(startedFile), 5_000, "slow task started");

		expect(await runner.cancel("slow")).toBe(true);
		expect(output.states.get("slow")?.state).toBe("stopped");
		expect(output.states.get("slow")?.detail).toBe("stopped");
	});
});
