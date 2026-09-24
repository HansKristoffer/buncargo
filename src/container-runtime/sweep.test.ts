import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessIdentity } from "../core/process-identity";
import {
	loadRuns,
	publishRun,
	type RunEntry,
	releaseRun,
} from "../core/run-registry";
import type { BuncargoContainer } from "../types";
import { withProjectLifecycleLock } from "./project-lock";
import { decideSweep, sweepOrphanedContainers } from "./sweep";
import type { ContainerDownRequest, ContainerRuntimeAdapter } from "./types";

const realHome = process.env.HOME;
let home = "";
let checkout = "";

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-sweep-"));
	process.env.HOME = home;
	checkout = mkdtempSync(join(tmpdir(), "buncargo-checkout-"));
});

afterAll(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(checkout, { recursive: true, force: true });
});

afterEach(() => {
	rmSync(join(home, ".buncargo", "runs.json"), { force: true });
});

const NOW = 1_000_000;
const DB = { name: "db", status: "ready" as const };
const AGES_AGO = new Date(NOW - 10_000_000).toISOString();

/** A run entry, dead by default: `pid: 1` is never one of ours. */
function entry(extra: Partial<RunEntry> = {}): RunEntry {
	return {
		sessionId: "s1",
		projectPrefix: "demo",
		projectName: "demo",
		root: checkout,
		worktree: null,
		pid: 1,
		startedAt: AGES_AGO,
		updatedAt: AGES_AGO,
		hosts: null,
		cli: { program: "bun" },
		apps: [],
		services: [{ name: "db", status: "ready" }],
		...extra,
	};
}

describe("decideSweep", () => {
	const base = {
		rootExists: true,
		anyRunning: true,
		run: null,
		ownerAlive: false,
		now: NOW,
	};
	const limits = { ownerDeadGraceMs: 15_000 };

	it("removes a stack whose checkout is gone, whatever else is true", () => {
		expect(
			decideSweep({ ...base, rootExists: false, ownerAlive: true }, limits),
		).toEqual({ kind: "down", reason: "checkout deleted" });
	});

	it("keeps anything with a live owner", () => {
		expect(
			decideSweep({ ...base, anyRunning: false, ownerAlive: true }, limits),
		).toEqual({ kind: "keep" });
	});

	it("removes a stopped stack nobody owns", () => {
		expect(decideSweep({ ...base, anyRunning: false }, limits)).toEqual({
			kind: "down",
			reason: "stopped with no owner",
		});
	});

	it("leaves a running stack with no entry alone", () => {
		expect(decideSweep(base, limits)).toEqual({ kind: "keep" });
	});

	it("holds a released stack for its idle timeout, then removes it", () => {
		const released = entry({
			releasedAt: new Date(NOW - 60_000).toISOString(),
			idleTimeoutMs: 120_000,
		});
		expect(decideSweep({ ...base, run: released }, limits)).toEqual({
			kind: "keep",
		});
		expect(
			decideSweep({ ...base, run: released, now: NOW + 60_000 }, limits),
		).toEqual({ kind: "down", reason: "released 120s ago" });
	});

	it("keeps a released stack forever when no idle timeout was set", () => {
		const kept = entry({ releasedAt: AGES_AGO });
		expect(decideSweep({ ...base, run: kept }, limits)).toEqual({
			kind: "keep",
		});
	});

	it("gives a crashed owner a grace counted from when a sweep first noticed", () => {
		const crashed = entry({
			idleTimeoutMs: 180_000,
			ownerLostAt: new Date(NOW - 10_000).toISOString(),
		});
		expect(decideSweep({ ...base, run: crashed }, limits)).toEqual({
			kind: "keep",
		});
		expect(
			decideSweep({ ...base, run: crashed, now: NOW + 5_000 }, limits),
		).toEqual({ kind: "down", reason: "owner gone for 15s" });
	});

	it("keeps a crashed owner nobody has stamped yet, however quiet it was", () => {
		// Measured from `updatedAt`, a run quiet for hours before it crashed
		// lost its containers on the very next pass, with no grace at all.
		const quiet = entry({ idleTimeoutMs: 180_000, updatedAt: AGES_AGO });
		expect(decideSweep({ ...base, run: quiet }, limits)).toEqual({
			kind: "keep",
		});
	});

	it("keeps a stack with no hold however its run ended, crash included", () => {
		// `--keep-containers`, a one-shot mode, or a script that brought a
		// stack up and exited: to the sweep the last looks exactly like a
		// crash, and tearing it down seconds later is not what anyone asked.
		const exited = entry({ ownerLostAt: AGES_AGO });
		expect(decideSweep({ ...base, run: exited }, limits)).toEqual({
			kind: "keep",
		});
	});
});

function container(
	project: string,
	root: string,
	state: string,
): BuncargoContainer {
	return {
		id: `${project}-id`,
		name: project,
		state,
		status: state,
		ports: "",
		project,
		root,
		worktree: "",
		service: "db",
		runtime: "docker",
	};
}

function stubRuntime(containers: BuncargoContainer[]) {
	const downs: ContainerDownRequest[] = [];
	const runtime = {
		name: "docker",
		displayName: "Docker",
		isAvailable: () => true,
		list: () => containers,
		down: async (request: ContainerDownRequest) => {
			downs.push(request);
		},
	} as unknown as ContainerRuntimeAdapter;
	return { runtime, downs };
}

describe("sweepOrphanedContainers", () => {
	it("removes deleted checkouts and stopped stacks, and skips the caller's own project", async () => {
		const gone = join(checkout, "deleted-worktree");
		const { runtime, downs } = stubRuntime([
			container("gone", gone, "running"),
			container("stopped", checkout, "exited"),
			container("mine", checkout, "exited"),
		]);
		const result = await sweepOrphanedContainers({
			runtimes: [runtime],
			except: { projectName: "mine", root: checkout },
		});
		expect(result.containers).toBe(3);
		expect(result.failed).toEqual([]);
		expect(
			result.swept.map((stack) => [stack.projectName, stack.reason]),
		).toEqual([
			["gone", "checkout deleted"],
			["stopped", "stopped with no owner"],
		]);
		expect(downs.map((request) => request.projectName)).toEqual([
			"gone",
			"stopped",
		]);
		expect(downs[0]).toMatchObject({ root: gone, verbose: false });
	});

	it("keeps a stack whose run is live and one still inside its idle hold", async () => {
		await publishRun(
			entry({
				sessionId: "live",
				projectName: "owned",
				pid: process.pid,
				processIdentity: readProcessIdentity(process.pid),
			}),
		);
		await publishRun(
			entry({
				sessionId: "held",
				projectName: "held",
				releasedAt: new Date().toISOString(),
				idleTimeoutMs: 60_000,
			}),
		);
		const { runtime, downs } = stubRuntime([
			container("owned", checkout, "running"),
			container("held", checkout, "running"),
		]);
		const result = await sweepOrphanedContainers({ runtimes: [runtime] });
		expect(result.swept).toEqual([]);
		expect(result.liveRuns).toBe(1);
		expect(downs).toEqual([]);
	});

	it("tears down through the binary the run pinned", async () => {
		await publishRun(
			entry({
				projectName: "pinned",
				releasedAt: new Date(Date.now() - 120_000).toISOString(),
				idleTimeoutMs: 60_000,
				services: [
					{
						name: "db",
						status: "ready",
						container: {
							runtime: "docker",
							name: "pinned-db",
							binary: "/nonexistent/docker",
						},
					},
				],
			}),
		);
		const { runtime, downs } = stubRuntime([
			container("pinned", checkout, "running"),
		]);
		const result = await sweepOrphanedContainers({ runtimes: [runtime] });
		// The stub never sees this teardown, and the failure names the pinned
		// path: together, proof that the binary from the entry was used rather
		// than the one that listed the container.
		expect(downs).toEqual([]);
		expect(result.swept).toEqual([]);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0]?.projectName).toBe("pinned");
		expect(result.failed[0]?.error).toContain("/nonexistent/docker");
	});

	it("skips a project whose lock is held and reports a failed down", async () => {
		const { runtime, downs } = stubRuntime([
			container("busy", checkout, "exited"),
		]);
		let release!: () => void;
		const held = withProjectLifecycleLock(
			"busy",
			checkout,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await Bun.sleep(20);
		const result = await sweepOrphanedContainers({ runtimes: [runtime] });
		release();
		await held;
		expect(result.swept).toEqual([]);
		expect(result.failed).toEqual([]);
		expect(downs).toEqual([]);

		runtime.down = async () => {
			throw new Error("daemon restarting");
		};
		const retry = await sweepOrphanedContainers({ runtimes: [runtime] });
		expect(retry.failed).toEqual([
			{ projectName: "busy", root: checkout, error: "daemon restarting" },
		]);
	});

	it("retires an entry once its containers are gone, and not before", async () => {
		await publishRun(
			entry({ sessionId: "finished", projectName: "finished", services: [DB] }),
		);
		await releaseRun("finished");

		// Still listed: the entry is what says these may be reused, so it has
		// to outlive the run and not the containers.
		const { runtime } = stubRuntime([
			container("finished", checkout, "running"),
		]);
		await sweepOrphanedContainers({ runtimes: [runtime], now: NOW });
		expect(await loadRuns()).toHaveLength(1);

		const empty = stubRuntime([]);
		await sweepOrphanedContainers({ runtimes: [empty.runtime] });
		expect(await loadRuns()).toEqual([]);
	});

	it("keeps entries when no runtime can answer, rather than reading silence as gone", async () => {
		await publishRun(
			entry({ sessionId: "unknown", projectName: "unknown", services: [DB] }),
		);
		await releaseRun("unknown");
		// No runtime is available: an empty listing means "cannot tell", and
		// retiring on that would throw away the record of a live stack.
		await sweepOrphanedContainers({ runtimes: [] });
		expect(await loadRuns()).toHaveLength(1);
	});

	it("stamps an owner it finds gone, and keeps the stack for the grace", async () => {
		await publishRun(
			entry({
				sessionId: "crashed",
				projectName: "crashed",
				idleTimeoutMs: 180_000,
				services: [DB],
			}),
		);
		const { runtime, downs } = stubRuntime([
			container("crashed", checkout, "running"),
		]);
		const first = await sweepOrphanedContainers({ runtimes: [runtime] });
		expect(first.swept).toEqual([]);
		expect(downs).toEqual([]);
		const stamped = (await loadRuns())[0]?.ownerLostAt;
		expect(stamped).toBeString();

		// A later pass counts from the same stamp, not from its own clock.
		await sweepOrphanedContainers({
			runtimes: [runtime],
			now: Date.parse(stamped ?? "") + 60_000,
		});
		expect((await loadRuns())[0]?.ownerLostAt).toBe(stamped);
		expect(downs.map((request) => request.projectName)).toEqual(["crashed"]);
	});

	it("touches nothing when the registry cannot be read", async () => {
		// With no registry every stack looks unowned; stopping is the only
		// safe answer, and the watchdog retries on its next pass.
		mkdirSync(join(home, ".buncargo"), { recursive: true });
		writeFileSync(join(home, ".buncargo", "runs.json"), "{ not json");
		const { runtime, downs } = stubRuntime([
			container("stopped", checkout, "exited"),
		]);
		await expect(
			sweepOrphanedContainers({ runtimes: [runtime] }),
		).rejects.toThrow();
		expect(downs).toEqual([]);
	});

	it("retires nothing for a runtime that could not answer", async () => {
		await publishRun(
			entry({
				sessionId: "apple-run",
				projectName: "apple-run",
				services: [
					{
						...DB,
						container: { runtime: "apple", name: "apple-run-db" },
					},
				],
			}),
		);
		await releaseRun("apple-run");
		// Docker answers with nothing; Apple is down. An empty Docker listing
		// says nothing about a stack Apple holds.
		const docker = stubRuntime([]);
		const apple = {
			name: "apple",
			list: () => {
				throw new Error("container system is not running");
			},
		} as unknown as ContainerRuntimeAdapter;
		const result = await sweepOrphanedContainers({
			runtimes: [docker.runtime, apple],
		});
		expect(result.answered).toEqual(["docker"]);
		expect(await loadRuns()).toHaveLength(1);
	});

	it("spares a stack a run claims while the pass is busy elsewhere", async () => {
		// The pass condemns both stacks from its snapshot. While it tears the
		// first down, a new run claims the second — publishing before it takes
		// the lock, as a real start does. The recheck under the lock must see it.
		await publishRun(
			entry({
				sessionId: "expired",
				projectName: "reused",
				releasedAt: new Date(Date.now() - 600_000).toISOString(),
				idleTimeoutMs: 60_000,
				services: [DB],
			}),
		);
		const downs: string[] = [];
		const runtime = {
			name: "docker",
			list: () => [
				container("abandoned", checkout, "exited"),
				container("reused", checkout, "running"),
			],
			down: async (request: ContainerDownRequest) => {
				downs.push(request.projectName);
				await publishRun(
					entry({
						sessionId: "new-run",
						projectName: "reused",
						pid: process.pid,
						processIdentity: readProcessIdentity(process.pid),
						services: [DB],
					}),
				);
			},
		} as unknown as ContainerRuntimeAdapter;
		const result = await sweepOrphanedContainers({ runtimes: [runtime] });
		expect(downs).toEqual(["abandoned"]);
		expect(result.remaining.map((group) => group.projectName)).toEqual([
			"reused",
		]);
	});
});
