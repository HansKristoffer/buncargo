import { expect, it } from "bun:test";
import { abortableSleep } from "../core/deadline";
import { stopDevServers } from "../core/process/dev-servers";
import { RunOutput } from "../core/process/run-output";
import { type ServerSessionSource, startServerSession } from "./server-session";

function source(
	overrides: Partial<ServerSessionSource> = {},
): ServerSessionSource {
	return {
		root: import.meta.dir,
		ports: {},
		appEnv: () => ({}),
		runHook: async () => {},
		waitForHealth: async () => {},
		recordCapture: async () => [],
		...overrides,
	};
}

it("joins seed readiness before keeping an empty tunnel session open", async () => {
	const events: string[] = [];
	await startServerSession(
		source({
			prepare: async () => {
				events.push("tunnels");
			},
			onSeedReady: () => {
				events.push("seed ready");
			},
			runHook: async () => {
				throw new Error("Empty sessions do not run server hooks");
			},
		}),
		{},
		{
			seed: async () => {
				await Bun.sleep(10);
				events.push("seed end");
				return { status: "not-needed" };
			},
			onReady: () => {
				events.push("ready");
			},
			stayOpen: async () => {
				events.push("stay open");
			},
		},
	);
	expect(events).toEqual([
		"tunnels",
		"seed end",
		"seed ready",
		"ready",
		"stay open",
	]);
});

it("cancels and drains the seed when preparation fails", async () => {
	let begin!: () => void;
	const began = new Promise<void>((resolve) => {
		begin = resolve;
	});
	let drained = false;
	await expect(
		startServerSession(
			source({
				prepare: async () => {
					await began;
					throw new Error("build failed");
				},
			}),
			{},
			{
				seed: async (signal) => {
					begin();
					try {
						await abortableSleep(60_000, signal);
						return { status: "not-needed" };
					} finally {
						await Bun.sleep(10);
						drained = true;
					}
				},
			},
		),
	).rejects.toThrow("build failed");
	expect(drained).toBe(true);
});

it("cancels preparation when the seed fails and never reports ready", async () => {
	let begin!: () => void;
	const began = new Promise<void>((resolve) => {
		begin = resolve;
	});
	let cancelled = false;
	let ready = false;
	await expect(
		startServerSession(
			source({
				prepare: async (signal) => {
					begin();
					try {
						await abortableSleep(60_000, signal);
					} finally {
						cancelled = signal.aborted;
					}
				},
			}),
			{},
			{
				seed: async () => {
					await began;
					throw new Error("seed failed");
				},
				onReady: () => {
					ready = true;
				},
			},
		),
	).rejects.toThrow("seed failed");
	expect(cancelled).toBe(true);
	expect(ready).toBe(false);
});

it("refuses a missing required secret before preparing or running beforeServers", async () => {
	const events: string[] = [];
	await expect(
		startServerSession(
			source({
				prepare: async () => {
					events.push("prepare");
				},
				runHook: async (phase) => {
					events.push(phase);
				},
			}),
			{
				api: {
					port: 1,
					devCommand: "exit 0",
					secrets: { required: ["BUNCARGO_TEST_REQUIRED_SECRET"] },
				},
			},
			{},
		),
	).rejects.toThrow("api: BUNCARGO_TEST_REQUIRED_SECRET");
	expect(events).toEqual([]);
});

it("marks each app ready as its health check passes, not with its wave", async () => {
	const silent = "bun -e 'setInterval(() => {}, 60000)'";
	const output = new RunOutput();
	const ready: string[] = [];
	let midWave: Record<string, unknown> = {};
	const pids = await startServerSession(
		source({
			waitForHealth: async (_apps, _signal, onAppReady) => {
				onAppReady?.("fast");
				midWave = {
					fast: output.states.get("fast")?.state,
					slow: output.states.get("slow")?.state,
					ready: [...ready],
				};
				onAppReady?.("slow");
			},
		}),
		{
			fast: { kind: "worker", devCommand: silent },
			slow: { kind: "worker", devCommand: silent },
		},
		{
			verbose: false,
			output,
			portDrift: false,
			onAppReady: (name) => ready.push(name),
		},
	);
	try {
		// The registry and the rows hear about `fast` while `slow` is still
		// being waited for.
		expect(midWave).toEqual({
			fast: "ready",
			slow: "starting",
			ready: ["fast"],
		});
		expect(ready).toEqual(["fast", "slow"]);
	} finally {
		await stopDevServers(pids);
	}
});
