import { afterEach, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDevConfig } from "../../config";
import { createDevEnvironment } from "../../environment";
import { startDevServers } from "./dev-servers";
import { ProcessOwner } from "./process-owner";
import type { AppChild } from "./pty-app";
import { findWorker, spawnOwnedWorker, stopWorker } from "./worker-ownership";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) {
		await stopWorker(root, "jobs");
		rmSync(root, { recursive: true, force: true });
	}
});

const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo-worker-"));
	roots.push(root);
	return root;
};
const command = `${process.execPath} -e 'setInterval(()=>{},1000)'`;
it("workers have an app overlay without fabricated endpoints", () => {
	const root = fixture();
	const config = defineDevConfig({
		projectPrefix: "worker",
		services: {},
		apps: {
			jobs: {
				kind: "worker",
				devCommand: command,
				staticEnv: { LOCAL: "app" },
				envVars: () => ({ VALUE: "overlay" }),
			},
		},
		env: () => ({ SHARED: "shared" }),
	});
	const env = createDevEnvironment(config, { root });
	expect(env.ports).toEqual({});
	expect(env.urls).toEqual({});
	const values = env.buildAppEnvVars("jobs");
	expect(values).toMatchObject({
		SHARED: "shared",
		LOCAL: "app",
		VALUE: "overlay",
	});
	expect(values).not.toHaveProperty("PORT");
	expect(values).not.toHaveProperty("JOBS_URL");
	// @ts-expect-error workers have no allocated port
	void env.ports.jobs;
	// @ts-expect-error workers have no generated URL
	void env.urls.jobs;
	// @ts-expect-error worker processes have no PORT contract
	void values.PORT;
});

it("serializes simultaneous worker starts and supports explicit takeover", async () => {
	const root = fixture();
	const run = () =>
		startDevServers(
			{ jobs: { kind: "worker", devCommand: command } },
			root,
			{ jobs: {} },
			{},
			{ verbose: false, skipContainers: true, deferPublicUrlApps: false },
		);
	const starts = await Promise.allSettled([run(), run()]);
	expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(
		1,
	);
	expect(starts.filter((result) => result.status === "rejected")).toHaveLength(
		1,
	);
	const first = await findWorker(root, "jobs");
	expect(first?.pid).toBeGreaterThan(1);
	expect(await stopWorker(root, "jobs")).toBe(true);
	const pids = await run();
	expect(pids.jobs).not.toBe(first?.pid);
});

it("an unexpected zero exit fails supervision and reports the worker", async () => {
	const root = fixture();
	const exits: string[] = [];
	await expect(
		startDevServers(
			{
				jobs: {
					kind: "worker",
					devCommand: `${process.execPath} -e 'setTimeout(()=>process.exit(0),250)'`,
				},
			},
			root,
			{ jobs: {} },
			{},
			{
				verbose: false,
				skipContainers: true,
				waitForExit: true,
				onAppExit: (name) => {
					exits.push(name);
				},
			},
		),
	).rejects.toThrow('App "jobs" exited with code 0');
	expect(exits).toEqual(["jobs"]);
});

it("cancels an owned worker while readiness is pending", async () => {
	const root = fixture();
	const controller = new AbortController();
	const running = startDevServers(
		{ jobs: { kind: "worker", devCommand: command } },
		root,
		{ jobs: {} },
		{},
		{
			verbose: false,
			skipContainers: true,
			signal: controller.signal,
			onAppSpawned: () => controller.abort(new Error("cancel worker")),
			waitForHealth: () => new Promise(() => {}),
		},
	);
	await expect(running).rejects.toThrow("cancel worker");
	expect(await findWorker(root, "jobs")).toBeUndefined();
});

it("cancellation remains attached after library readiness and stop cleans owned workers", async () => {
	for (const cancel of [true, false]) {
		const root = fixture();
		const controller = new AbortController();
		const env = createDevEnvironment(
			{
				projectPrefix: "worker",
				services: {},
				apps: { jobs: { kind: "worker", devCommand: command } },
				options: { verbose: false },
			},
			{ root },
		);
		await env.start({ signal: controller.signal, productionBuild: false });
		expect(await findWorker(root, "jobs")).toBeDefined();
		if (cancel) controller.abort();
		else await env.stop();
		const deadline = Date.now() + 3000;
		while (await findWorker(root, "jobs")) {
			if (Date.now() > deadline) throw new Error("worker survived cleanup");
			await Bun.sleep(20);
		}
	}
});

/** A worker that is already gone when its claim checks on it. */
function exitedChild(): AppChild {
	const child = Object.assign(new EventEmitter(), {
		pid: 2 ** 22,
		exitCode: 3,
		signalCode: null,
	});
	queueMicrotask(() => child.emit("spawn"));
	return child as unknown as AppChild;
}

it("hands a non-essential worker that died while being claimed to the supervisor", async () => {
	const root = fixture();
	await expect(spawnOwnedWorker(root, "jobs", exitedChild)).rejects.toThrow(
		'Worker "jobs" exited before process startup',
	);
	const child = await spawnOwnedWorker(root, "jobs", exitedChild, undefined, {
		allowEarlyExit: true,
	});
	expect(child.exitCode).toBe(3);
	expect(await findWorker(root, "jobs")).toBeUndefined();

	// The supervisor reports its exit although it never sees an `exit` event.
	const exits: (number | null)[] = [];
	const owner = new ProcessOwner({
		optional: new Set(["jobs"]),
		onAppExit: (_name, code) => exits.push(code),
	});
	try {
		owner.register("jobs", child, false, true);
		await Bun.sleep(0);
		expect(exits).toEqual([3]);
		expect(owner.controller.signal.aborted).toBe(false);
	} finally {
		owner.dispose();
	}
});

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** `real`, but reporting `spawn` only once it has exited: it died while being claimed. */
function deadOnArrival(real: ChildProcess): AppChild {
	const child = new EventEmitter();
	for (const key of ["pid", "exitCode", "signalCode"] as const)
		Object.defineProperty(child, key, { get: () => real[key] });
	real.once("exit", () => child.emit("spawn"));
	return child as unknown as AppChild;
}

it("stops what a worker that died while being claimed left running", async () => {
	const root = fixture();
	const real = spawn("sh", ["-c", "sleep 60 & echo $!; exit 3"], {
		detached: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const descendant = new Promise<number>((resolve) =>
		real.stdout?.once("data", (data) => resolve(Number(String(data).trim()))),
	);
	const child = await spawnOwnedWorker(
		root,
		"jobs",
		() => deadOnArrival(real),
		undefined,
		{ allowEarlyExit: true },
	);
	expect(child.exitCode).toBe(3);
	expect(alive(await descendant)).toBe(false);
});

it("hands back a non-essential worker that died while its claim was written", async () => {
	const root = fixture();
	const real = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	const registryFile = join(root, ".buncargo", "workers.json");
	// Exits the moment its claim reaches the disk.
	let exitCode: number | null = null;
	const child = Object.defineProperties(new EventEmitter(), {
		pid: { get: () => real.pid },
		exitCode: {
			get: () => {
				if (existsSync(registryFile)) exitCode = 3;
				return exitCode;
			},
		},
		signalCode: { value: null },
	});

	const handed = await spawnOwnedWorker(
		root,
		"jobs",
		() => {
			queueMicrotask(() => child.emit("spawn"));
			return child as unknown as AppChild;
		},
		undefined,
		{ allowEarlyExit: true },
	);
	expect(handed.exitCode).toBe(3);
	expect(await findWorker(root, "jobs")).toBeUndefined();
	if (existsSync(registryFile))
		expect(readFileSync(registryFile, "utf8")).not.toContain('"jobs"');
	for (let i = 0; i < 40 && alive(real.pid ?? 0); i++) await Bun.sleep(25);
	expect(real.exitCode !== null || real.signalCode !== null).toBe(true);
});
