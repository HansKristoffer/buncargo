import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unreadableCheckout } from "../core/checkout-presence.testing";
import {
	loadHostRoutes,
	pidRouteOwners,
	upsertHostRoutes,
} from "../core/hosts/registry";
import {
	claimOffset,
	getOffsetClaimsPath,
	offsetClaimHoldsBlock,
	offsetClaimKey,
	readAllOffsetClaims,
	readOffsetClaims,
} from "../core/offset-claims";
import { readProcessIdentity } from "../core/process-identity";
import { readRemovals } from "../core/removal-log";
import {
	holdToInherit,
	LIVE,
	loadRuns,
	markOwnersLost,
	publishRun,
	type RunEntry,
	releaseRun,
} from "../core/run-registry";
import { runEntry } from "../core/run-registry.testing";
import { useTempHome } from "../core/test-env.testing";
import { DELETED_CHECKOUT_SETTLE_MS } from "../core/watchdog-constants";
import type { BuncargoContainer, BuncargoVolume } from "../types";
import {
	fakeAppleRuntime,
	fakeRuntime,
	listedAs,
} from "./fake-runtime.testing";
import { withProjectLifecycleLock } from "./project-lock";
import {
	decideSweep,
	type SweepResult,
	settleDeletedCheckouts,
	sweepOrphanedContainers,
} from "./sweep";
import type { ComposeProjectResources, ContainerDownRequest } from "./types";

// Each test's runs, claims and routes start empty.
const home = useTempHome();
let checkout = "";
const unreadable = unreadableCheckout();

beforeAll(() => {
	checkout = mkdtempSync(join(tmpdir(), "buncargo-checkout-"));
});

afterAll(() => {
	rmSync(checkout, { recursive: true, force: true });
	unreadable?.cleanup();
});

/** Give `root` a port claim for `projectName`, as a run of this user's does. */
function claim(projectName: string, root: string) {
	claimOffset({ root, offset: 100, ports: [], projectName });
}

const NOW = 1_000_000;
const DB = { name: "db", status: "ready" as const };
const AGES_AGO = new Date(NOW - 10_000_000).toISOString();

/** A run entry, dead by default: `pid: 1` is never one of ours. */
function entry(extra: Partial<RunEntry> = {}): RunEntry {
	return runEntry({
		root: checkout,
		pid: 1,
		startedAt: AGES_AGO,
		updatedAt: AGES_AGO,
		services: [DB],
		...extra,
	});
}

describe("decideSweep", () => {
	const base = {
		known: true,
		checkout: "present" as const,
		anyRunning: true,
		run: null,
		ownerAlive: false,
		now: NOW,
	};
	const limits = { ownerDeadGraceMs: 15_000 };

	it("removes a stack whose checkout is gone once no live run owns it", () => {
		const held = entry({
			lifecycle: { state: "released", at: new Date(NOW).toISOString() },
		});
		expect(
			decideSweep({ ...base, checkout: "deleted", run: held }, limits),
		).toEqual({ kind: "down", reason: "checkout deleted" });
	});

	it("keeps a stack its live owner holds, even when its checkout reads deleted", () => {
		expect(
			decideSweep({ ...base, checkout: "deleted", ownerAlive: true }, limits),
		).toEqual({ kind: "keep" });
	});

	it("never reads a checkout it cannot read as deleted", () => {
		const exited = entry({ lifecycle: { state: "lost", at: AGES_AGO } });
		expect(
			decideSweep({ ...base, checkout: "unknown", run: exited }, limits),
		).toEqual({ kind: "keep" });
	});

	it("keeps anything with a live owner", () => {
		expect(
			decideSweep({ ...base, anyRunning: false, ownerAlive: true }, limits),
		).toEqual({ kind: "keep" });
	});

	it("reports a stack this user's state does not name, whatever else is true", () => {
		for (const [checkout, anyRunning, reason] of [
			["deleted", false, "its checkout was deleted"],
			["unknown", true, "this user cannot read its checkout"],
			["present", false, "it is stopped"],
			["present", true, "it is running"],
		] as const)
			expect(
				decideSweep({ ...base, known: false, checkout, anyRunning }, limits),
			).toEqual({ kind: "foreign", reason });
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
			lifecycle: {
				state: "released",
				at: new Date(NOW - 60_000).toISOString(),
			},
			hold: { kind: "timed", ms: 120_000, inherited: false },
		});
		expect(decideSweep({ ...base, run: released }, limits)).toEqual({
			kind: "keep",
		});
		expect(
			decideSweep({ ...base, run: released, now: NOW + 60_000 }, limits),
		).toEqual({ kind: "down", reason: "released 120s ago" });
	});

	it("keeps a released stack forever when no idle timeout was set", () => {
		const kept = entry({ lifecycle: { state: "released", at: AGES_AGO } });
		expect(decideSweep({ ...base, run: kept }, limits)).toEqual({
			kind: "keep",
		});
	});

	it("gives a crashed owner a grace counted from when a sweep first noticed", () => {
		const crashed = entry({
			hold: { kind: "timed", ms: 180_000, inherited: false },
			lifecycle: { state: "lost", at: new Date(NOW - 10_000).toISOString() },
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
		const quiet = entry({
			hold: { kind: "timed", ms: 180_000, inherited: false },
			updatedAt: AGES_AGO,
		});
		expect(decideSweep({ ...base, run: quiet }, limits)).toEqual({
			kind: "keep",
		});
	});

	it("applies a hold a run without one reused, counted from when that run ended", () => {
		const script = entry({
			hold: { kind: "timed", ms: 180_000, inherited: true },
			lifecycle: { state: "lost", at: new Date(NOW - 60_000).toISOString() },
		});
		expect(decideSweep({ ...base, run: script }, limits)).toEqual({
			kind: "keep",
		});
		expect(
			decideSweep({ ...base, run: script, now: NOW + 120_000 }, limits),
		).toEqual({
			kind: "down",
			reason: "ended 180s ago, past the hold it reused",
		});
		// Still running: nothing has ended yet.
		const running = entry({
			hold: { kind: "timed", ms: 180_000, inherited: true },
		});
		expect(
			decideSweep({ ...base, run: running, now: NOW + 10_000_000 }, limits),
		).toEqual({ kind: "keep" });
	});

	it("keeps a stack with no hold however its run ended, crash included", () => {
		// `--keep-containers`, a one-shot mode, or a script that brought a
		// stack up and exited: to the sweep the last looks exactly like a
		// crash, and tearing it down seconds later is not what anyone asked.
		const exited = entry({ lifecycle: { state: "lost", at: AGES_AGO } });
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

function stubRuntime(
	containers: BuncargoContainer[],
	volumes: BuncargoVolume[] = [],
) {
	const downs: ContainerDownRequest[] = [];
	const runtime = fakeRuntime({
		containers: async () => containers.map(listedAs),
		listVolumes: async () => volumes,
		down: async (request: ContainerDownRequest) => {
			downs.push(request);
		},
	});
	return { runtime, downs };
}

/** Every claim on record, and whether it holds its block. */
function claimStates(): Record<string, "holds" | "released"> {
	return Object.fromEntries(
		Object.entries(readAllOffsetClaims()).map(([key, claim]) => [
			key,
			offsetClaimHoldsBlock(claim) ? "holds" : "released",
		]),
	);
}

describe("sweepOrphanedContainers", () => {
	it("removes deleted checkouts and stopped stacks, and skips the caller's own project", async () => {
		const gone = join(checkout, "deleted-worktree");
		claim("gone", gone);
		claim("stopped", checkout);
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

	it("downs a crash-looping stack nobody owns, and keeps one whose state it cannot read", async () => {
		// Counting `restarting` as up kept a stack known only by its claim
		// forever: nothing owns it to stop it, and it serves nothing.
		const other = join(checkout, "other-worktree");
		mkdirSync(other, { recursive: true });
		claim("looping", checkout);
		claim("unreadable", other);
		const { runtime, downs } = stubRuntime([
			container("looping", checkout, "restarting"),
			container("unreadable", other, "some-new-state"),
		]);

		const result = await sweepOrphanedContainers({ runtimes: [runtime] });

		expect(
			result.swept.map((stack) => [stack.projectName, stack.reason]),
		).toEqual([["looping", "stopped with no owner"]]);
		expect(downs.map((request) => request.projectName)).toEqual(["looping"]);
	});

	it("gives back the block of a throwaway stack it removes, and keeps a dev checkout's", async () => {
		// A CI job killed before its teardown leaves its stack and its claim;
		// the runner's directory stays, so nothing else would free the block.
		claimOffset({
			root: checkout,
			suffix: "e2e",
			offset: 200,
			ports: [],
			projectName: "demo-e2e",
		});
		claim("demo", checkout);
		const { runtime } = stubRuntime([
			container("demo-e2e", checkout, "exited"),
			container("demo", checkout, "exited"),
		]);

		// Hours later: a claim used within the hour may be a new job's that
		// has not published its run yet.
		const result = await sweepOrphanedContainers({
			runtimes: [runtime],
			now: Date.now() + 2 * 3_600_000,
		});

		expect(result.swept.map((stack) => stack.projectName)).toEqual([
			"demo-e2e",
			"demo",
		]);
		// The e2e claim stays, naming the project its volumes belong to.
		expect(claimStates()).toEqual({
			[offsetClaimKey(checkout, "e2e")]: "released",
			[checkout]: "holds",
		});
	});

	it("keeps a recent claim of a stack with no run on record", async () => {
		// The last job's run is gone from the registry, and a new job of the
		// directory has allocated but not yet published its run.
		claimOffset({
			root: checkout,
			suffix: "e2e",
			offset: 200,
			ports: [],
			projectName: "demo-e2e",
		});
		const { runtime } = stubRuntime([
			container("demo-e2e", checkout, "exited"),
		]);

		const result = await sweepOrphanedContainers({ runtimes: [runtime] });

		expect(result.swept.map((stack) => stack.projectName)).toEqual([
			"demo-e2e",
		]);
		expect(Object.keys(readAllOffsetClaims())).toEqual([
			offsetClaimKey(checkout, "e2e"),
		]);
	});

	it("keeps the block a new job of the directory claimed before publishing its run", async () => {
		// The job allocates before it claims its run; the last job's stack
		// coming down in that window took the new job's claim with it.
		await publishRun(
			entry({
				sessionId: "last-job",
				projectName: "demo-e2e",
				lifecycle: { state: "released", at: AGES_AGO },
				hold: { kind: "timed", ms: 1_000, inherited: false },
			}),
		);
		claimOffset({
			root: checkout,
			suffix: "e2e",
			offset: 200,
			ports: [],
			projectName: "demo-e2e",
		});
		const { runtime } = stubRuntime([
			container("demo-e2e", checkout, "running"),
		]);

		const result = await sweepOrphanedContainers({ runtimes: [runtime] });

		expect(result.swept.map((stack) => stack.projectName)).toEqual([
			"demo-e2e",
		]);
		expect(Object.keys(readAllOffsetClaims())).toEqual([
			offsetClaimKey(checkout, "e2e"),
		]);
	});

	it("frees the claim of a throwaway run killed before its teardown, once nothing of it is left", async () => {
		// A CI run killed by its runner: no teardown released its claim, and
		// its directory stays.
		const throwaway = (projectName: string, suffix?: string) =>
			claimOffset({
				root: checkout,
				suffix,
				offset: 200,
				ports: [],
				projectName,
				throwaway: true,
			});
		throwaway("demo-e2e", "e2e");
		throwaway("demo-ci-held", "ci");
		claim("demo", checkout);
		const startedAt = new Date().toISOString();
		const killed = (sessionId: string, projectName: string) =>
			publishRun(entry({ sessionId, projectName, startedAt }));
		await killed("e2e", "demo-e2e");
		await killed("ci", "demo-ci-held");
		await killed("dev", "demo");
		const { runtime } = stubRuntime([
			container("demo-ci-held", checkout, "running"),
		]);

		await sweepOrphanedContainers({ runtimes: [runtime] });

		// Its containers still up: the run is not over yet.
		expect(claimStates()).toEqual({
			[checkout]: "holds",
			[offsetClaimKey(checkout, "ci")]: "holds",
			[offsetClaimKey(checkout, "e2e")]: "released",
		});
		expect((await loadRuns()).map((run) => run.sessionId)).toEqual(["ci"]);
	});

	it("keeps a throwaway claim a newer job made, or a live run holds", async () => {
		// The last job's containers are gone; the claim is newer than its run.
		await publishRun(entry({ sessionId: "last-job", projectName: "demo-ci" }));
		claimOffset({
			root: checkout,
			offset: 200,
			ports: [],
			projectName: "demo-ci",
			throwaway: true,
		});
		const live = join(checkout, "live-worktree");
		mkdirSync(live, { recursive: true });
		claimOffset({
			root: live,
			offset: 300,
			ports: [],
			projectName: "live-ci",
			throwaway: true,
		});
		await publishRun(
			entry({
				sessionId: "live",
				projectName: "live-ci",
				root: live,
				pid: process.pid,
				processIdentity: readProcessIdentity(process.pid),
				startedAt: new Date().toISOString(),
				services: [],
			}),
		);

		await sweepOrphanedContainers({ runtimes: [stubRuntime([]).runtime] });

		expect(Object.keys(readAllOffsetClaims()).sort()).toEqual([checkout, live]);
	});

	it("frees a throwaway claim with no run on record only once it is an hour old, and retires it once nothing of it is left", async () => {
		claimOffset({
			root: checkout,
			offset: 200,
			ports: [],
			projectName: "demo-ci",
			throwaway: true,
		});
		const { runtime } = stubRuntime([]);
		const hourLater = Date.now() + 3_600_000;

		await sweepOrphanedContainers({ runtimes: [runtime] });
		expect(claimStates()).toEqual({ [checkout]: "holds" });

		await sweepOrphanedContainers({ runtimes: [], now: hourLater });
		expect(claimStates()).toEqual({ [checkout]: "holds" });

		await sweepOrphanedContainers({ runtimes: [runtime], now: hourLater });
		expect(claimStates()).toEqual({ [checkout]: "released" });

		// No container, run or volume of its project is left.
		await sweepOrphanedContainers({ runtimes: [runtime], now: hourLater });
		expect(readAllOffsetClaims()).toEqual({});
	});

	it("keeps a throwaway claim that gave its block up while a volume of its project is left", async () => {
		// The claim is what says the volume is this checkout's once the
		// checkout is deleted; retired, nothing would name it.
		claimOffset({
			root: checkout,
			offset: 200,
			ports: [],
			projectName: "demo-e2e",
			suffix: "e2e",
			throwaway: true,
		});
		const volume = { name: "demo-e2e_db", project: "demo-e2e" } as const;
		const { runtime } = stubRuntime([], [{ ...volume, runtime: "docker" }]);
		const hourLater = Date.now() + 3_600_000;

		await sweepOrphanedContainers({ runtimes: [runtime], now: hourLater });
		await sweepOrphanedContainers({ runtimes: [runtime], now: hourLater });

		expect(claimStates()).toEqual({
			[offsetClaimKey(checkout, "e2e")]: "released",
		});
	});

	it("keeps a throwaway claim that gave its block up while the runtime cannot list volumes", async () => {
		claimOffset({
			root: checkout,
			offset: 200,
			ports: [],
			projectName: "demo-e2e",
			suffix: "e2e",
			throwaway: true,
		});
		const runtime = fakeRuntime({
			containers: async () => [],
			listVolumes: async () => {
				throw new Error("docker volume ls exited 1");
			},
		});
		const hourLater = Date.now() + 3_600_000;

		await sweepOrphanedContainers({ runtimes: [runtime], now: hourLater });
		await sweepOrphanedContainers({ runtimes: [runtime], now: hourLater });

		expect(claimStates()).toEqual({
			[offsetClaimKey(checkout, "e2e")]: "released",
		});
	});

	it("reports a stack this user's state does not name, and leaves it alone", async () => {
		// Another user's stack on a shared daemon: no run and no claim of ours
		// names it, so its checkout reading deleted and its containers being
		// stopped say nothing about whether anyone still needs it.
		const theirs = join(checkout, "another-users-checkout");
		await publishRun(entry({ projectName: "theirs", root: checkout }));
		claim("theirs", join(checkout, "elsewhere"));
		const { runtime, downs } = stubRuntime([
			container("theirs", theirs, "exited"),
		]);
		const result = await sweepOrphanedContainers({ runtimes: [runtime] });
		expect(downs).toEqual([]);
		expect(result.swept).toEqual([]);
		expect(result.foreign).toEqual([
			{
				projectName: "theirs",
				root: theirs,
				runtime: "docker",
				reason: "its checkout was deleted",
				command: "docker compose -p theirs down",
			},
		]);
		expect(result.remaining.map((group) => group.projectName)).toEqual([
			"theirs",
		]);
	});

	it.skipIf(!unreadable)(
		"keeps a stack whose checkout it cannot read",
		async () => {
			// Another user's home: existsSync reads it as missing, and a
			// watchdog once tore down every stack under it as deleted.
			const root = unreadable?.root ?? "";
			await publishRun(
				entry({ sessionId: "other-user", projectName: "e2e", root }),
			);
			const { runtime, downs } = stubRuntime([
				container("e2e", root, "running"),
			]);
			const result = await sweepOrphanedContainers({ runtimes: [runtime] });
			expect(result.swept).toEqual([]);
			expect(downs).toEqual([]);
			expect(await loadRuns()).toHaveLength(1);
		},
	);

	it("keeps a live run's containers and integration stacks when its checkout reads deleted", async () => {
		const gone = join(checkout, "deleted-while-running");
		const marker = join(checkout, "live-stack-downs");
		await publishRun(
			entry({
				sessionId: "live",
				projectName: "live",
				root: gone,
				pid: process.pid,
				processIdentity: readProcessIdentity(process.pid),
				stacks: [
					{ name: "supabase", down: ["sh", "-c", `echo down >> '${marker}'`] },
				],
			}),
		);
		const { runtime, downs } = stubRuntime([
			container("live", gone, "running"),
		]);
		const result = await sweepOrphanedContainers({ runtimes: [runtime] });
		expect(result.swept).toEqual([]);
		expect(downs).toEqual([]);
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("records each removal with who did it and the run it was decided against", async () => {
		// The run that loses these reads this record to say who removed them;
		// the containers themselves are gone and cannot carry it.
		const now = Date.now();
		await publishRun(
			entry({
				sessionId: "released",
				projectName: "expired",
				pid: 4242,
				worktree: "feature",
				branch: "feature/login",
				lifecycle: {
					state: "released",
					at: new Date(now - 120_000).toISOString(),
				},
				hold: { kind: "timed", ms: 60_000, inherited: false },
			}),
		);
		const { runtime } = stubRuntime([
			container("expired", checkout, "running"),
		]);
		const actor = {
			command: "buncargo watchdog",
			pid: 777,
			user: "ci",
			version: "13.0.0",
		};
		const result = await sweepOrphanedContainers({
			runtimes: [runtime],
			actor,
			now,
		});

		const owner = {
			sessionId: "released",
			pid: 4242,
			worktree: "feature",
			branch: "feature/login",
		};
		expect(result.swept).toEqual([
			{
				projectName: "expired",
				root: checkout,
				runtime: "docker",
				reason: "released 120s ago",
				owner,
			},
		]);
		const [record] = readRemovals().filter(
			(entry) => entry.projectName === "expired",
		);
		expect(record).toMatchObject({
			projectName: "expired",
			root: checkout,
			runtime: "docker",
			reason: "released 120s ago",
			owner,
			by: actor,
		});
		expect(Date.parse(record?.at ?? "")).toBeGreaterThanOrEqual(now);
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
				lifecycle: { state: "released", at: new Date().toISOString() },
				hold: { kind: "timed", ms: 60_000, inherited: false },
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

	it("takes down a held stack a hold-less library run reused, once the hold is over after it ends", async () => {
		// hellu: a detached run released with a three-minute hold; a library
		// `start()` reused its containers four minutes later and exited after
		// a second. Its entry, the newest, asked for no hold, and the sweep
		// kept the stack for 13 days.
		const released = Date.now();
		await publishRun(
			entry({
				sessionId: "cli",
				projectName: "reused",
				detached: true,
				hold: { kind: "timed", ms: 180_000, inherited: false },
				startedAt: new Date(released - 600_000).toISOString(),
				updatedAt: new Date(released - 600_000).toISOString(),
			}),
		);
		await releaseRun("cli");
		const claimedAt = new Date(released + 240_000).toISOString();
		await publishRun(
			entry({
				sessionId: "library",
				projectName: "reused",
				startedAt: claimedAt,
				updatedAt: claimedAt,
				hold: holdToInherit(await loadRuns(), {
					projectName: "reused",
					root: checkout,
				}),
			}),
		);
		const { runtime, downs } = stubRuntime([
			container("reused", checkout, "running"),
		]);

		// The library run has exited: the first pass notices, the hold starts.
		const noticed = released + 241_000;
		const first = await sweepOrphanedContainers({
			runtimes: [runtime],
			now: noticed,
		});
		expect(first.swept).toEqual([]);
		expect(downs).toEqual([]);

		const later = await sweepOrphanedContainers({
			runtimes: [runtime],
			now: noticed + 180_000,
		});
		expect(later.swept.map((stack) => stack.reason)).toEqual([
			"ended 180s ago, past the hold it reused",
		]);
		expect(downs.map((down) => down.projectName)).toEqual(["reused"]);
	});

	it("tears down through the binary the run pinned", async () => {
		await publishRun(
			entry({
				projectName: "pinned",
				lifecycle: {
					state: "released",
					at: new Date(Date.now() - 120_000).toISOString(),
				},
				hold: { kind: "timed", ms: 60_000, inherited: false },
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
		claim("busy", checkout);
		const { runtime, downs } = stubRuntime([
			container("busy", checkout, "exited"),
		]);
		let release!: () => void;
		let acquired!: () => void;
		const isHeld = new Promise<void>((resolve) => {
			acquired = resolve;
		});
		const held = withProjectLifecycleLock(
			"busy",
			checkout,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
					acquired();
				}),
		);
		await isHeld;
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

	it("stops a released run's integration stack after its hold, and retires the entry", async () => {
		// The Supabase CLI's containers carry none of our labels, so no listing
		// finds them: the recorded command is the only way to stop them.
		const marker = join(checkout, "stack-downs");
		const stacks = [
			{ name: "supabase", down: ["sh", "-c", `echo down >> '${marker}'`] },
		];
		await publishRun(
			entry({
				sessionId: "held",
				projectName: "held",
				lifecycle: {
					state: "released",
					at: new Date(Date.now() - 30_000).toISOString(),
				},
				hold: { kind: "timed", ms: 60_000, inherited: false },
				stacks,
			}),
		);
		await publishRun(
			entry({
				sessionId: "expired",
				projectName: "expired",
				lifecycle: {
					state: "released",
					at: new Date(Date.now() - 120_000).toISOString(),
				},
				hold: { kind: "timed", ms: 60_000, inherited: false },
				stacks,
			}),
		);
		const { runtime } = stubRuntime([]);

		const result = await sweepOrphanedContainers({ runtimes: [runtime] });

		expect(result.swept).toEqual([
			expect.objectContaining({ projectName: "expired", runtime: "supabase" }),
		]);
		expect(readFileSync(marker, "utf8")).toBe("down\n");
		expect(result.pendingStacks).toBe(1);
		expect((await loadRuns()).map((run) => run.sessionId)).toEqual(["held"]);
		rmSync(marker);
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
				hold: { kind: "timed", ms: 180_000, inherited: false },
				services: [DB],
			}),
		);
		const { runtime, downs } = stubRuntime([
			container("crashed", checkout, "running"),
		]);
		const first = await sweepOrphanedContainers({ runtimes: [runtime] });
		expect(first.swept).toEqual([]);
		expect(downs).toEqual([]);
		const stamped = (await loadRuns())[0]?.lifecycle;
		if (stamped?.state !== "lost") throw new Error("the owner was not stamped");

		// A later pass counts from the same stamp, not from its own clock.
		await sweepOrphanedContainers({
			runtimes: [runtime],
			now: Date.parse(stamped.at) + 60_000,
		});
		expect((await loadRuns())[0]?.lifecycle).toEqual(stamped);
		expect(downs.map((request) => request.projectName)).toEqual(["crashed"]);
	});

	it("lets the session that ended last decide, however recently another was patched", async () => {
		// A finished session's service watch writes a `problem`, which moves
		// its `updatedAt`. Ordered by that, its one-second hold decided for a
		// stack a later run had released into a three-minute hold.
		const released = (msAgo: number) => new Date(NOW - msAgo).toISOString();
		await publishRun(
			entry({
				sessionId: "earlier",
				projectName: "shared",
				lifecycle: { state: "released", at: released(600_000) },
				updatedAt: released(1_000),
				hold: { kind: "timed", ms: 1_000, inherited: false },
			}),
		);
		await publishRun(
			entry({
				sessionId: "later",
				projectName: "shared",
				lifecycle: { state: "released", at: released(60_000) },
				updatedAt: released(60_000),
				hold: { kind: "timed", ms: 180_000, inherited: false },
			}),
		);
		const { runtime, downs } = stubRuntime([
			container("shared", checkout, "running"),
		]);

		await sweepOrphanedContainers({ runtimes: [runtime], now: NOW });

		expect(downs).toEqual([]);
		const target = { projectName: "shared", root: checkout };
		expect(holdToInherit(await loadRuns(), target)).toEqual({
			kind: "timed",
			ms: 180_000,
			inherited: true,
		});
	});

	it("forgets a lost-owner stamp once the owner reads as itself again", async () => {
		// One wrong "gone" reading stamped a live run for good, and
		// `holdToInherit` counted it as finished.
		await publishRun(
			entry({
				sessionId: "live",
				projectName: "live",
				pid: process.pid,
				processIdentity: readProcessIdentity(process.pid),
				hold: { kind: "timed", ms: 180_000, inherited: false },
				services: [DB],
			}),
		);
		await markOwnersLost({
			lost: [entry({ sessionId: "live" })],
			back: [],
			at: AGES_AGO,
		});
		const { runtime, downs } = stubRuntime([
			container("live", checkout, "running"),
		]);

		await sweepOrphanedContainers({ runtimes: [runtime], now: NOW });

		expect(downs).toEqual([]);
		expect((await loadRuns())[0]?.lifecycle).toEqual(LIVE);
	});

	it("touches nothing when the registry cannot be read", async () => {
		// With no registry every stack looks unowned; stopping is the only
		// safe answer, and the watchdog retries on its next pass.
		mkdirSync(join(home(), ".buncargo"), { recursive: true });
		writeFileSync(join(home(), ".buncargo", "runs.json"), "{ not json");
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
		const apple = fakeAppleRuntime({
			containers: async () => {
				throw new Error("container system is not running");
			},
		});
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
				lifecycle: {
					state: "released",
					at: new Date(Date.now() - 600_000).toISOString(),
				},
				hold: { kind: "timed", ms: 60_000, inherited: false },
				services: [DB],
			}),
		);
		claim("abandoned", checkout);
		const downs: string[] = [];
		const runtime = fakeRuntime({
			containers: async () =>
				[
					container("abandoned", checkout, "exited"),
					container("reused", checkout, "running"),
				].map(listedAs),
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
		});
		const result = await sweepOrphanedContainers({ runtimes: [runtime] });
		expect(downs).toEqual(["abandoned"]);
		expect(result.remaining.map((group) => group.projectName)).toEqual([
			"reused",
		]);
	});
});

describe("sweepOrphanedContainers, against a registry that changes under it", () => {
	it("keeps a session that released and claimed again under the same id during the pass", async () => {
		// Finished when the pass read it; a library `start()` claims again
		// under the same session while the pass is busy with another stack.
		await publishRun(
			entry({ sessionId: "library", projectName: "library", services: [DB] }),
		);
		await releaseRun("library");
		claim("abandoned", checkout);
		const runtime = fakeRuntime({
			containers: async () =>
				[container("abandoned", checkout, "exited")].map(listedAs),
			down: async () => {
				await publishRun(
					entry({
						sessionId: "library",
						projectName: "library",
						pid: process.pid,
						processIdentity: readProcessIdentity(process.pid),
						services: [DB],
					}),
				);
			},
		});
		await sweepOrphanedContainers({ runtimes: [runtime] });
		expect((await loadRuns()).map((run) => run.sessionId)).toEqual(["library"]);
	});

	it("lets the newest entry of a checkout decide its integration stack", async () => {
		// An older session's own hold is long over, but a newer one of the
		// same checkout released minutes ago into a longer hold.
		const marker = join(checkout, "stack-downs");
		await publishRun(
			entry({
				sessionId: "older",
				startedAt: new Date(Date.now() - 3_600_000).toISOString(),
				lifecycle: {
					state: "released",
					at: new Date(Date.now() - 600_000).toISOString(),
				},
				hold: { kind: "timed", ms: 60_000, inherited: false },
				stacks: [
					{ name: "supabase", down: ["sh", "-c", `echo down >> '${marker}'`] },
				],
			}),
		);
		await publishRun(
			entry({
				sessionId: "newer",
				startedAt: new Date(Date.now() - 300_000).toISOString(),
				lifecycle: {
					state: "released",
					at: new Date(Date.now() - 60_000).toISOString(),
				},
				hold: { kind: "timed", ms: 3_600_000, inherited: false },
			}),
		);
		const result = await sweepOrphanedContainers({
			runtimes: [stubRuntime([]).runtime],
		});
		expect(result.swept).toEqual([]);
		expect(existsSync(marker)).toBe(false);
	});
});

describe("sweepOrphanedContainers, for a deleted checkout's integration stack", () => {
	const gone = join(tmpdir(), "buncargo-deleted-checkout-never-existed");
	const missingCli = join(gone, "node_modules", ".bin", "buncargo-test-cli");
	const deletedRun = (stack: { down: string[]; composeProject?: string }) =>
		entry({
			sessionId: "deleted",
			root: gone,
			lifecycle: { state: "released", at: AGES_AGO },
			hold: { kind: "timed", ms: 60_000, inherited: false },
			stacks: [{ name: "supabase", ...stack }],
		});

	/** Docker as far as the label fallback needs it, recording what it is asked. */
	function dockerWithStack(resources: ComposeProjectResources) {
		const asked = { stopped: [] as string[], volumes: [] as string[] };
		const runtime = fakeRuntime({
			listComposeProjectResources: async () => resources,
			stop: async (ids: string[]) => {
				asked.stopped.push(...ids);
			},
			removeVolumes: async (names: string[]) => {
				asked.volumes.push(...names);
				return [];
			},
		});
		return { runtime, asked };
	}

	it("runs the stack's CLI from PATH when the checkout's copy is gone", async () => {
		const bin = mkdtempSync(join(tmpdir(), "buncargo-path-"));
		const marker = join(bin, "called");
		writeFileSync(
			join(bin, "buncargo-test-cli"),
			`#!/bin/sh\necho "$*" > '${marker}'\n`,
			{ mode: 0o755 },
		);
		const path = process.env.PATH;
		process.env.PATH = `${bin}:${path}`;
		try {
			await publishRun(deletedRun({ down: [missingCli, "stop"] }));
			await sweepOrphanedContainers({ runtimes: [stubRuntime([]).runtime] });
			expect(readFileSync(marker, "utf8")).toBe("stop\n");
			expect(await loadRuns()).toEqual([]);
		} finally {
			process.env.PATH = path;
			rmSync(bin, { recursive: true, force: true });
		}
	});

	it("stops its containers by Compose project when no CLI is left, keeping volumes", async () => {
		const { runtime, asked } = dockerWithStack({
			containers: [
				{ id: "api", project: "demo-stack", running: true, root: "" },
				{ id: "exited", project: "demo-stack", running: false, root: "" },
				{ id: "neighbour", project: "other", running: true, root: "" },
			],
			volumes: [{ name: "demo-stack_db", project: "demo-stack" }],
			networks: [],
		});
		await publishRun(
			deletedRun({ down: [missingCli, "stop"], composeProject: "demo-stack" }),
		);
		const result = await sweepOrphanedContainers({ runtimes: [runtime] });
		expect(asked).toEqual({ stopped: ["api"], volumes: [] });
		expect(result.swept).toEqual([
			expect.objectContaining({ root: gone, runtime: "supabase" }),
		]);
		expect(await loadRuns()).toEqual([]);
	});

	it("keeps the entry, and reports it, when nothing records the containers' project", async () => {
		const { runtime, asked } = dockerWithStack({
			containers: [],
			volumes: [],
			networks: [],
		});
		await publishRun(deletedRun({ down: [missingCli, "stop"] }));
		const result = await sweepOrphanedContainers({ runtimes: [runtime] });
		expect(asked.stopped).toEqual([]);
		expect(result.failed).toEqual([expect.objectContaining({ root: gone })]);
		expect((await loadRuns()).map((run) => run.sessionId)).toEqual(["deleted"]);
	});
});

describe("sweepOrphanedContainers and named hosts", () => {
	it("withdraws a checkout's service routes with the stack it takes down", async () => {
		await upsertHostRoutes(
			[
				{
					hostname: "typesense.demo.localhost",
					port: 8108,
					kind: "service",
					name: "typesense",
					root: checkout,
				},
				{
					hostname: "typesense.other.localhost",
					port: 9108,
					kind: "service",
					name: "typesense",
					root: home(),
				},
			],
			{ owners: pidRouteOwners },
		);
		claim("stopped", checkout);
		const { runtime } = stubRuntime([container("stopped", checkout, "exited")]);
		await sweepOrphanedContainers({ runtimes: [runtime] });
		expect((await loadHostRoutes()).map((route) => route.hostname)).toEqual([
			"typesense.other.localhost",
		]);
	});
});

describe("settleDeletedCheckouts", () => {
	const gone = join(tmpdir(), "buncargo-never-existed");
	const optIn = process.env.BUNCARGO_PRUNE_DELETED_CHECKOUTS;
	/** A pass long enough after the first to confirm the deletion. */
	const LATER = NOW + DELETED_CHECKOUT_SETTLE_MS;

	afterEach(() => {
		if (optIn === undefined)
			delete process.env.BUNCARGO_PRUNE_DELETED_CHECKOUTS;
		else process.env.BUNCARGO_PRUNE_DELETED_CHECKOUTS = optIn;
	});

	function setup(options: {
		enabled: boolean;
		claims: Record<string, string>;
		left?: BuncargoContainer[];
	}) {
		if (options.enabled) process.env.BUNCARGO_PRUNE_DELETED_CHECKOUTS = "1";
		else delete process.env.BUNCARGO_PRUNE_DELETED_CHECKOUTS;
		for (const [root, projectName] of Object.entries(options.claims))
			claimOffset({ root, offset: 100, ports: [5532], projectName });

		const removed: string[][] = [];
		const runtime = fakeRuntime({
			containers: async () => (options.left ?? []).map(listedAs),
			listVolumes: async () => [
				{ name: "app-gone_db", project: "app-gone", runtime: "docker" },
				{
					name: "app-gone-e2e_db",
					project: "app-gone-e2e",
					runtime: "docker",
				},
				{ name: "other_db", project: "other", runtime: "docker" },
				{ name: "loose", runtime: "docker" },
			],
			removeVolumes: async (names: string[]) => {
				removed.push(names);
				return [];
			},
		});
		const result: Pick<SweepResult, "swept" | "failed"> = {
			swept: [],
			failed: [],
		};
		/** One sweep pass's settling, at `now`. */
		const settle = (
			now: number,
			extra: Partial<Parameters<typeof settleDeletedCheckouts>[0]> = {},
		) =>
			settleDeletedCheckouts({
				runtimes: [runtime],
				runs: [],
				stacks: [],
				result,
				now,
				swept: async (stack) => void result.swept.push(stack),
				...extra,
			});
		return { removed, result, settle };
	}
	const claimedRoots = () => Object.keys(readAllOffsetClaims());

	it("without the opt-in removes nothing, and keeps a claim only while its project has volumes", async () => {
		// The claim is the record `prune` proposes those volumes by.
		const empty = join(tmpdir(), "buncargo-never-existed-either");
		const { removed, settle } = setup({
			enabled: false,
			claims: { [gone]: "app-gone", [empty]: "no-volumes" },
		});
		await settle(NOW);
		await settle(LATER);
		expect(removed).toEqual([]);
		expect(claimedRoots()).toEqual([gone]);
	});

	it("removes a deleted checkout's project volumes once a later pass finds it still gone, then its claim", async () => {
		const { removed, result, settle } = setup({
			enabled: true,
			claims: { [gone]: "app-gone", [checkout]: "other" },
		});

		// The first sighting is only stamped: a path briefly missing must not
		// cost a database.
		await settle(NOW);
		expect(removed).toEqual([]);
		expect(readAllOffsetClaims()[gone]?.deletedSeenAt).toBe(
			new Date(NOW).toISOString(),
		);
		await settle(LATER - 1);
		expect(removed).toEqual([]);

		await settle(LATER);
		expect(removed).toEqual([["app-gone_db"]]);
		expect(claimedRoots()).toEqual([checkout]);
		expect(result.swept).toHaveLength(1);
	});

	it("starts over for a checkout that comes back before it is settled", async () => {
		const root = join(checkout, "comes-back");
		const { removed, settle } = setup({
			enabled: true,
			claims: { [root]: "app-gone" },
		});
		await settle(NOW);
		expect(readAllOffsetClaims()[root]?.deletedSeenAt).toBeString();

		mkdirSync(root);
		await settle(NOW + 1);
		expect(readAllOffsetClaims()[root]?.deletedSeenAt).toBeUndefined();

		rmSync(root, { recursive: true });
		await settle(LATER);
		expect(removed).toEqual([]);
		expect(readAllOffsetClaims()[root]?.deletedSeenAt).toBe(
			new Date(LATER).toISOString(),
		);
	});

	it("settles a deleted checkout's suffixed environments with it, including one whose run gave its block up", async () => {
		const { removed, settle } = setup({
			enabled: true,
			claims: { [gone]: "app-gone", [checkout]: "other" },
		});
		claimOffset({
			root: gone,
			offset: 200,
			ports: [5632],
			projectName: "app-gone-e2e",
			suffix: "e2e",
			throwaway: true,
		});
		// Its run was torn down before the checkout was deleted.
		const document = JSON.parse(readFileSync(getOffsetClaimsPath(), "utf-8"));
		document.claims[offsetClaimKey(gone, "e2e")].reclaimedAt = AGES_AGO;
		writeFileSync(getOffsetClaimsPath(), JSON.stringify(document));
		await settle(NOW);
		await settle(LATER);
		expect(removed.flat().sort()).toEqual(["app-gone-e2e_db", "app-gone_db"]);
		expect(claimedRoots()).toEqual([checkout]);
	});

	it("keeps volumes another checkout or run still uses, and waits out leftover containers", async () => {
		const run = { projectName: "app-gone", root: checkout } as RunEntry;
		const leftover = container("app-gone", gone, "exited");
		for (const [runs, claims, left, settled] of [
			[[], { [gone]: "app-gone", [checkout]: "app-gone" }, [], true],
			[[run], { [gone]: "app-gone" }, [], true],
			[[], { [gone]: "app-gone" }, [leftover], false],
		] as const) {
			const { removed, settle } = setup({
				enabled: true,
				claims,
				left: [...left],
			});
			await settle(NOW, { runs: [...runs] });
			await settle(LATER, { runs: [...runs] });
			expect(removed).toEqual([]);
			expect(claimedRoots().includes(gone)).toBe(!settled);
			rmSync(getOffsetClaimsPath(), { force: true });
		}
	});

	it.skipIf(!unreadable)(
		"never settles a checkout it cannot read, nor removes a project such a checkout claims",
		async () => {
			const root = unreadable?.root ?? "";
			const { removed, settle } = setup({
				enabled: true,
				claims: { [gone]: "app-gone", [root]: "app-gone" },
			});
			expect(Object.keys(readOffsetClaims())).toEqual([root]);
			await settle(NOW);
			await settle(LATER);
			expect(removed).toEqual([]);
			expect(claimedRoots()).toContain(root);
			expect(readAllOffsetClaims()[root]?.deletedSeenAt).toBeUndefined();

			delete process.env.BUNCARGO_PRUNE_DELETED_CHECKOUTS;
			await settle(LATER);
			expect(claimedRoots()).toEqual([root]);
		},
	);

	it("keeps a deleted checkout's claim while a stack of it is still listed", async () => {
		// The claim is what makes the stack this user's: dropped while the
		// stack stands (its removal failed, or its lock was busy), the stack
		// would be nobody's to remove.
		for (const enabled of [false, true]) {
			const { removed, settle } = setup({
				enabled,
				claims: { [gone]: "app-gone" },
			});
			const stacks = [{ projectName: "app-gone", root: gone }];
			await settle(NOW, { stacks });
			await settle(LATER, { stacks });
			expect(removed).toEqual([]);
			expect(claimedRoots()).toEqual([gone]);
			rmSync(getOffsetClaimsPath(), { force: true });
		}
	});

	it("decides nothing while no runtime answers", async () => {
		// Its stack could still be on the runtime that did not answer.
		for (const enabled of [false, true]) {
			const { removed, settle } = setup({
				enabled,
				claims: { [gone]: "app-gone" },
			});
			await settle(NOW, { runtimes: [] });
			await settle(LATER, { runtimes: [] });
			expect(removed).toEqual([]);
			expect(claimedRoots()).toEqual([gone]);
			rmSync(getOffsetClaimsPath(), { force: true });
		}
	});
});
