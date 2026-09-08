import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDevConfig } from "../../config";
import { createDevEnvironment } from "../../environment";
import { startDevServers } from "./dev-servers";
import { findWorker, stopWorker } from "./worker-ownership";

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
