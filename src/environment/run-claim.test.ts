import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApp, resolveServices } from "../config/resolve";
import { readLeases } from "../core/leases";
import {
	type AppEvent,
	AppFailure,
	type AppLife,
	initialLife,
	transition,
} from "../core/process/app-lifecycle";
import { flushRunPatches, type RunSource } from "../core/run-publish";
import {
	findRunsByRoot,
	loadRuns,
	patchRun,
	type RunEntry,
	type RunHold,
} from "../core/run-registry";
import { libraryLeasePolicy } from "./app-leases";
import type { DevEnvContext } from "./context";
import { createDevEnvironment } from "./create-dev-environment";
import { createRunClaimApi, resolveClaimHold } from "./run-claim";

/** How a library start claims its apps: no reused ones, no services listed. */
const appsOnly = { policy: libraryLeasePolicy, serviceNames: [] };

const realHome = process.env.HOME;
let home = "";

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-run-claim-"));
	process.env.HOME = home;
});

afterAll(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
});

/** Walk an app through its lifecycle as the spawner does, reporting each step. */
function stepper(
	claim: Pick<ReturnType<typeof createRunClaimApi>, "appEvents">,
) {
	const lives = new Map<string, AppLife>();
	return (name: string, event: AppEvent) => {
		const previous =
			lives.get(name) ??
			initialLife({
				optional: false,
				worker: true,
				checked: false,
				attached: false,
			});
		const life = transition(previous, event);
		lives.set(name, life);
		void claim.appEvents.onAppPhase?.(name, life, previous);
	};
}

describe("resolveClaimHold", () => {
	it("keeps a library run's containers unless something asks for a hold", () => {
		// A script that brings a stack up and exits looks like a crash to the
		// sweep; with a hold it would lose its containers seconds later.
		expect(resolveClaimHold({}, undefined)).toBeUndefined();
	});

	it("ignores `options.autoShutdown` for a library run, which is the CLI's", () => {
		// The configured hold is `buncargo dev`'s. Applied to a script that
		// exits normally, it is the crash path: containers gone in seconds.
		expect(resolveClaimHold({}, 60_000)).toBeUndefined();
		expect(
			resolveClaimHold({ defaultIdleTimeoutMs: 180_000 }, false),
		).toBeUndefined();
	});

	it("uses the caller's default only when neither the flag nor the config says", () => {
		// The CLI's three minutes.
		expect(resolveClaimHold({ defaultIdleTimeoutMs: 180_000 }, undefined)).toBe(
			180_000,
		);
		expect(resolveClaimHold({ defaultIdleTimeoutMs: 180_000 }, 60_000)).toBe(
			60_000,
		);
	});

	it("puts an explicit request above everything, `false` included", () => {
		expect(resolveClaimHold({ idleTimeoutMs: 5_000 }, 60_000)).toBe(5_000);
		expect(
			resolveClaimHold(
				{ idleTimeoutMs: false, defaultIdleTimeoutMs: 180_000 },
				60_000,
			),
		).toBeUndefined();
	});
});

describe("createRunClaimApi", () => {
	function claimApi() {
		return createRunClaimApi(
			{
				config: { projectPrefix: "demo", services: {}, apps: {} },
				projectName: "demo-claim",
				root: home,
				worktree: false,
				services: { postgres: {} },
				selectedServiceKeys: ["postgres"],
				hasSelectedServices: true,
				runtime: { name: "docker" },
				runtimeBinary: "docker",
			} as unknown as DevEnvContext,
			() => {
				throw new Error("a services claim builds no app rows");
			},
		);
	}

	async function holdOf(sessionId: string) {
		const entry = (await loadRuns()).find((run) => run.sessionId === sessionId);
		expect(entry).toBeDefined();
		return entry?.hold;
	}

	it("claims again after a claim that never reached the registry", async () => {
		// An aborted claim used to count as made: the next start skipped it and
		// created containers no entry owned, which `stop` and the sweep missed.
		const claim = claimApi();
		await expect(
			claim.claimRun({ signal: AbortSignal.abort() }),
		).rejects.toThrow();
		expect(claim.claimedAt).toBeUndefined();

		await claim.claimRun();
		expect(
			(await loadRuns()).some((run) => run.sessionId === claim.sessionId),
		).toBe(true);
		await claim.retireRun({ containersDown: true });
	});

	it("keeps the hold it was first claimed with when `restart()` claims again", async () => {
		// `restart()` retires the claim and claims again with only a signal.
		// Resolving that afresh lost the hold, so the containers were kept
		// forever after a restart.
		const claim = claimApi();
		const fiveSeconds: RunHold = { kind: "timed", ms: 5_000, inherited: false };
		await claim.claimRun({ idleTimeoutMs: 5_000 });
		expect(await holdOf(claim.sessionId)).toEqual(fiveSeconds);

		await claim.retireRun({ containersDown: true });
		await claim.claimRun({});
		expect(await holdOf(claim.sessionId)).toEqual(fiveSeconds);

		await claim.retireRun({ containersDown: true });
		await claim.claimRun({ idleTimeoutMs: false });
		expect(await holdOf(claim.sessionId)).toEqual({ kind: "checkout" });
		await claim.retireRun({ containersDown: true });
	});
	it("takes over the hold of a stack another run left in its hold, unless it asked for a hold itself", async () => {
		// A detached run released with three minutes; a one-second library
		// `start()` reused its containers, and its "keep forever" entry, the
		// newest, pinned the stack for 13 days.
		const cli = claimApi();
		await cli.claimRun({ defaultIdleTimeoutMs: 180_000 });
		await cli.releaseRun();

		const script = claimApi();
		await script.claimRun();
		expect(await holdOf(script.sessionId)).toEqual({
			kind: "timed",
			ms: 180_000,
			inherited: true,
		});

		// `--keep-containers` asks for no hold on purpose: nothing to inherit.
		const kept = claimApi();
		await kept.claimRun({ idleTimeoutMs: false });
		expect(await holdOf(kept.sessionId)).toEqual({ kind: "checkout" });

		for (const claim of [cli, script, kept])
			await claim.retireRun({ containersDown: true });
	});

	it("marks the claimed services ready once they were waited for", async () => {
		// A library `start()` with no apps describes nothing, and the claim
		// lists its services as `starting`: they read so for the whole run.
		const claim = claimApi();
		await claim.claimRun();
		const status = async () =>
			(await loadRuns()).find((run) => run.sessionId === claim.sessionId)
				?.services[0]?.status;
		expect(await status()).toBe("starting");

		claim.servicesReady(["postgres"]);
		const deadline = performance.now() + 5_000;
		while ((await status()) !== "ready" && performance.now() < deadline)
			await Bun.sleep(10);
		expect(await status()).toBe("ready");
		await claim.retireRun({ containersDown: true });
	});
});

describe("a claim's lifecycle and its apps", () => {
	function appClaimApi(root: string, services: RunSource["services"] = {}) {
		const ctx = {
			config: { projectPrefix: "demo", services: {}, apps: {} },
			projectName: "demo-apps",
			root,
			worktree: false,
			services: { postgres: {} },
			selectedServiceKeys: ["postgres"],
			hasSelectedServices: true,
			runtime: { name: "docker" },
			runtimeBinary: "docker",
		} as unknown as DevEnvContext;
		const source = (): RunSource => ({
			sessionId: api.sessionId,
			projectPrefix: "demo",
			projectName: "demo-apps",
			root,
			isWorktree: false,
			ports: {},
			urls: {},
			loopbackUrls: {},
			publicUrls: {},
			services,
			hosts: null,
			resolvePrimaryApp: () => undefined,
		});
		const api = createRunClaimApi(ctx, source);
		return api;
	}
	const worker = (exclusive?: string) =>
		resolveApp({
			kind: "worker",
			devCommand: "true",
			...(exclusive ? { exclusive } : {}),
		});

	it("has no claim time once released or retired", async () => {
		// `explainMissingContainers` reads removals since the claim; a released
		// claim's time is no claim's.
		const claim = appClaimApi(mkdtempSync(join(home, "claimed-at-")));
		expect(claim.claimedAt).toBeUndefined();
		await claim.claimRun();
		expect(claim.claimedAt).toBeNumber();
		await claim.releaseRun();
		expect(claim.claimedAt).toBeUndefined();
		await claim.claimRun();
		await claim.retireRun({ containersDown: true });
		expect(claim.claimedAt).toBeUndefined();
	});

	it("gives back only what the failed start took, when starts overlap", async () => {
		// `abandonApps` knew only the last `claimApps`, so a failed start gave
		// back the leases of the one that ran beside it.
		const claim = appClaimApi(mkdtempSync(join(home, "overlap-")));
		const first = await claim.claimApps({ a: worker("demo:a") }, appsOnly);
		await claim.claimApps({ b: worker("demo:b") }, appsOnly);

		await claim.abandonApps(first.apps);

		const held = (await readLeases()).map((lease) => lease.key);
		expect(held).toEqual(["demo:b"]);
		await claim.releaseApps();
	});

	it("records a restart and a parked app on the rows, as `dev` does", async () => {
		// A library start left a restarted app `ready`, so `buncargo wait`
		// answered from the process being replaced, and a parked one as it was.
		const root = mkdtempSync(join(home, "restart-park-"));
		const claim = appClaimApi(root);
		const session = { sessionId: claim.sessionId };
		const status = async (name: string) =>
			(await loadRuns())
				.find((run) => run.sessionId === claim.sessionId)
				?.apps.find((app) => app.name === name)?.status;
		await claim.claimApps({ web: worker(), jobs: worker() }, appsOnly);
		const step = stepper(claim);
		step("web", { type: "spawned", pid: 1_000_011, probation: false });
		step("jobs", { type: "spawned", pid: 1_000_012, probation: false });
		step("web", { type: "ready" });

		step("web", { type: "restarting", reason: "requested" });
		const failure = new AppFailure("jobs", "not-ready", "did not respond");
		step("jobs", { type: "failed", failure, park: true });
		await flushRunPatches(session);

		expect(await status("web")).toBe("starting");
		expect(await status("jobs")).toBe("failed");
		await claim.releaseApps();
	});

	it("never reads a service `buncargo stop` stopped as ready, until a start ensures it again", async () => {
		// A library `claimApps` describes every service `ready`, and the run's
		// readiness report is queued: either landing after the stop resurrected
		// the service.
		const root = mkdtempSync(join(home, "stopped-service-"));
		const claim = appClaimApi(root, resolveServices({ postgres: {} }));
		const session = { sessionId: claim.sessionId };
		const status = async () =>
			(await loadRuns()).find((run) => run.sessionId === claim.sessionId)
				?.services[0]?.status;
		await claim.claimRun();
		await patchRun(claim.sessionId, {
			services: [{ name: "postgres", status: "stopped" }],
		});
		claim.servicesReady(["postgres"]);
		await flushRunPatches(session);
		expect(await status()).toBe("stopped");

		await claim.claimApps(
			{ jobs: worker() },
			{ ...appsOnly, serviceNames: ["postgres"] },
		);
		expect(await status()).toBe("stopped");

		// A second `start()` under the same claim brings it up again.
		await claim.claimRun();
		claim.servicesReady(["postgres"]);
		await flushRunPatches(session);
		expect(await status()).toBe("ready");
		await claim.releaseApps();
		await claim.retireRun({ containersDown: true });
	});

	it("leaves a restarted app starting when a later start lists another", async () => {
		// The rows replay put the old `failed` back over the new process.
		const root = mkdtempSync(join(home, "replay-"));
		const claim = appClaimApi(root);
		const session = { sessionId: claim.sessionId };
		const row = async () =>
			(await loadRuns()).find((run) => run.sessionId === claim.sessionId)
				?.apps[0];
		await claim.claimApps({ first: worker() }, appsOnly);
		const step = stepper(claim);
		step("first", { type: "spawned", pid: 1_000_001, probation: false });
		step("first", {
			type: "exited",
			exit: { code: 1, signal: null },
			runEnding: false,
		});
		await flushRunPatches(session);
		expect((await row())?.status).toBe("failed");
		step("first", { type: "spawned", pid: 1_000_002, probation: false });

		await claim.claimApps({ second: worker() }, appsOnly);
		await flushRunPatches(session);

		expect(await row()).toMatchObject({ pid: 1_000_002, status: "starting" });
		await claim.releaseApps();
	});
});

describe("a library start's apps", () => {
	/** The registry is written behind the start; read it until `ready` holds. */
	async function entryWhen(
		root: string,
		sessionId: string,
		ready: (run: RunEntry) => boolean,
	): Promise<RunEntry | undefined> {
		const deadline = performance.now() + 5_000;
		for (;;) {
			const run = (await findRunsByRoot(root)).find(
				(entry) => entry.sessionId === sessionId,
			);
			if ((run && ready(run)) || performance.now() > deadline) return run;
			await Bun.sleep(20);
		}
	}

	it("lists an app-only run with its apps while they run, and withdraws it on stop", async () => {
		// `ls`, `stop` and BuncargoBar read this entry; a library run without
		// containers used to write none, so none of them saw its apps.
		const root = mkdtempSync(join(home, "app-only-"));
		const env = createDevEnvironment(
			{
				projectPrefix: "library-apps",
				services: {},
				apps: {
					jobs: {
						kind: "worker",
						devCommand: `${process.execPath} -e 'setInterval(() => {}, 1000)'`,
						exclusive: "library-apps:jobs",
					},
				},
				options: { verbose: false },
			},
			{ root },
		);
		const pids = await env.start({
			productionBuild: false,
			verbose: false,
			watchdog: false,
		});
		try {
			const run = await entryWhen(
				root,
				env.sessionId,
				(entry) =>
					entry.apps[0]?.status === "ready" &&
					entry.apps[0]?.processIdentity !== undefined,
			);
			expect(run?.pid).toBe(process.pid);
			expect(run?.services).toEqual([]);
			expect(run?.apps).toMatchObject([
				{
					name: "jobs",
					kind: "worker",
					pid: pids?.jobs,
					exclusive: "library-apps:jobs",
					status: "ready",
				},
			]);
		} finally {
			await env.stop({ verbose: false });
		}

		expect(
			(await loadRuns()).filter((run) => run.sessionId === env.sessionId),
		).toEqual([]);
		expect(await readLeases()).toEqual([]);
	});

	it("keeps an earlier app's row when a later start lists another", async () => {
		// The second publish rewrites every row as `starting`; the first app
		// would otherwise lose the pid `stop` needs to signal it.
		const root = mkdtempSync(join(home, "two-starts-"));
		const app = {
			kind: "worker" as const,
			devCommand: `${process.execPath} -e 'setInterval(() => {}, 1000)'`,
		};
		const env = createDevEnvironment(
			{
				projectPrefix: "library-two-starts",
				services: {},
				apps: { first: app, second: app },
				options: { verbose: false },
			},
			{ root },
		);
		try {
			const first = await env.startServers({ onlyApps: ["first"] });
			const second = await env.startServers({ onlyApps: ["second"] });
			const run = await entryWhen(root, env.sessionId, (entry) =>
				entry.apps.every(
					(row) => row.status === "ready" && row.processIdentity,
				),
			);
			expect(
				run?.apps.map(({ name, pid, status }) => ({ name, pid, status })),
			).toEqual([
				{ name: "first", pid: first.first, status: "ready" },
				{ name: "second", pid: second.second, status: "ready" },
			]);
		} finally {
			await env.stop({ verbose: false });
		}
	});
});
