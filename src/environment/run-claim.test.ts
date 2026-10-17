import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLeases } from "../core/leases";
import { findRunsByRoot, loadRuns, type RunEntry } from "../core/run-registry";
import type { DevEnvContext } from "./context";
import { createDevEnvironment } from "./create-dev-environment";
import { createRunClaimApi, resolveClaimHold } from "./run-claim";

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
			} as unknown as DevEnvContext<
				Record<string, never>,
				Record<string, never>
			>,
			() => {
				throw new Error("a services claim builds no app rows");
			},
		);
	}

	async function holdOf(sessionId: string) {
		const entry = (await loadRuns()).find((run) => run.sessionId === sessionId);
		expect(entry).toBeDefined();
		return entry?.idleTimeoutMs;
	}

	it("keeps the hold it was first claimed with when `restart()` claims again", async () => {
		// `restart()` retires the claim and claims again with only a signal.
		// Resolving that afresh lost the hold, so the containers were kept
		// forever after a restart.
		const claim = claimApi();
		await claim.claimRun({ idleTimeoutMs: 5_000 });
		expect(await holdOf(claim.sessionId)).toBe(5_000);

		await claim.retireRun();
		await claim.claimRun({});
		expect(await holdOf(claim.sessionId)).toBe(5_000);

		await claim.retireRun();
		await claim.claimRun({ idleTimeoutMs: false });
		expect(await holdOf(claim.sessionId)).toBeUndefined();
		await claim.retireRun();
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
