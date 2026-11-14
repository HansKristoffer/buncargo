import { describe, expect, it } from "bun:test";
import {
	defaultTypecheckConcurrency,
	LOCAL_TYPECHECK_CONCURRENCY_CAP,
	orderForFirstFailure,
	requestedTypecheckConcurrency,
	runBounded,
	selectWorkspaces,
	sortWorkspacesByExpectedDuration,
} from "./scheduling";

describe("sortWorkspacesByExpectedDuration", () => {
	const workspaces = [
		{ path: "apps/platform", fileCount: 513 },
		{ path: "apps/expo", fileCount: 136 },
		{ path: "apps/backend", fileCount: 2341 },
	];

	it("orders by cached duration, longest first", () => {
		const sorted = sortWorkspacesByExpectedDuration(workspaces, {
			"apps/backend": 30.9,
			"apps/expo": 25.5,
			"apps/platform": 8.2,
		});
		expect(sorted.map((workspace) => workspace.path)).toEqual([
			"apps/backend",
			"apps/expo",
			"apps/platform",
		]);
	});

	it("falls back to descending file count when the cache is empty", () => {
		const sorted = sortWorkspacesByExpectedDuration(workspaces, {});
		expect(sorted.map((workspace) => workspace.path)).toEqual([
			"apps/backend",
			"apps/platform",
			"apps/expo",
		]);
	});

	it("places untimed workspaces after timed ones, then by file count", () => {
		const mixed = [...workspaces, { path: "packages/new", fileCount: 50 }];
		const sorted = sortWorkspacesByExpectedDuration(mixed, {
			"apps/backend": 30.9,
			"apps/platform": 8.2,
		});
		expect(sorted.map((workspace) => workspace.path)).toEqual([
			"apps/backend",
			"apps/platform",
			"apps/expo",
			"packages/new",
		]);
	});
});

describe("defaultTypecheckConcurrency", () => {
	it("caps local at 4 and sizes CI by memory", () => {
		const gb = 1024 ** 3;
		expect(defaultTypecheckConcurrency({}, 64, 314 * gb)).toBe(
			LOCAL_TYPECHECK_CONCURRENCY_CAP,
		);
		// A 7 GB hosted runner, a 16 GB one, and a large self-hosted server.
		expect(defaultTypecheckConcurrency({ CI: "1" }, 2, 7.7 * gb)).toBe(2);
		expect(defaultTypecheckConcurrency({ CI: "1" }, 4, 15.6 * gb)).toBe(4);
		expect(defaultTypecheckConcurrency({ CI: "1" }, 8, 15.6 * gb)).toBe(4);
		expect(defaultTypecheckConcurrency({ CI: "1" }, 64, 314 * gb)).toBe(64);
		expect(defaultTypecheckConcurrency({ CI: "1" }, 8, 2 * gb)).toBe(1);
	});

	it("never goes below 1", () => {
		expect(defaultTypecheckConcurrency({}, 0)).toBe(1);
	});

	it("honours BUNCARGO_TYPECHECK_CONCURRENCY over the CPU default", () => {
		expect(
			defaultTypecheckConcurrency({ BUNCARGO_TYPECHECK_CONCURRENCY: "3" }, 8),
		).toBe(3);
		expect(
			defaultTypecheckConcurrency(
				{ CI: "1", BUNCARGO_TYPECHECK_CONCURRENCY: "3" },
				8,
			),
		).toBe(3);
	});
});

describe("requestedTypecheckConcurrency", () => {
	const env = { BUNCARGO_TYPECHECK_CONCURRENCY: "1" };

	it("takes the flag, then the env var, then the config", () => {
		expect(requestedTypecheckConcurrency(3, 2, env)).toBe(3);
		expect(requestedTypecheckConcurrency(undefined, 2, env)).toBe(1);
		expect(requestedTypecheckConcurrency(undefined, 2, {})).toBe(2);
		expect(requestedTypecheckConcurrency(undefined, undefined, {})).toBe(
			undefined,
		);
	});
});

describe("selectWorkspaces", () => {
	const workspaces = [
		{ path: "apps/platform" },
		{ path: "apps/backend" },
		{ path: "packages/utils" },
	];

	it("matches by path and basename and keeps incoming order", () => {
		const { selected, unknown } = selectWorkspaces(workspaces, [
			"backend",
			"apps/platform",
		]);
		expect(unknown).toEqual([]);
		expect(selected.map((workspace) => workspace.path)).toEqual([
			"apps/platform",
			"apps/backend",
		]);
	});

	it("reports unknown names", () => {
		const { selected, unknown } = selectWorkspaces(workspaces, [
			"mobile",
			"platform",
		]);
		expect(unknown).toEqual(["mobile"]);
		expect(selected.map((workspace) => workspace.path)).toEqual([
			"apps/platform",
		]);
	});
});

describe("runBounded", () => {
	it("rejects with a failed job's error only after the others have ended, and starts no more", async () => {
		const failed = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		let slowEnded = false;
		let thirdStarted = false;
		const pool = runBounded(
			[
				async () => {
					failed.resolve();
					throw new Error("boom");
				},
				async () => {
					await gate.promise;
					slowEnded = true;
				},
				async () => {
					thirdStarted = true;
				},
			],
			2,
		);
		const outcome = pool.then(
			() => "resolved",
			(error: Error) => ({ message: error.message, slowEnded }),
		);
		await failed.promise;
		// Every pending reaction has run: a pool that gave up early has settled.
		await new Promise((resolve) => setImmediate(resolve));
		gate.resolve();
		expect(await outcome).toEqual({ message: "boom", slowEnded: true });
		expect(thirdStarted).toBe(false);
	});

	it("starts nothing more once aborted, and rejects with the abort after the running jobs", async () => {
		const controller = new AbortController();
		const started: number[] = [];
		const jobs = [0, 1, 2].map((index) => async () => {
			started.push(index);
			if (index === 0) controller.abort(new Error("interrupted"));
		});
		await expect(runBounded(jobs, 1, controller.signal)).rejects.toThrow(
			"interrupted",
		);
		expect(started).toEqual([0]);
	});
});

describe("orderForFirstFailure", () => {
	const longestFirst = [
		"platform 24s",
		"marketing 9s",
		"expo 3s",
		"backend 2s",
	];

	it("keeps the longest job first and runs the rest shortest first beside it", () => {
		expect(orderForFirstFailure(longestFirst, 2)).toEqual([
			"platform 24s",
			"backend 2s",
			"expo 3s",
			"marketing 9s",
		]);
		expect(orderForFirstFailure(longestFirst, 3)).toEqual([
			"platform 24s",
			"marketing 9s",
			"backend 2s",
			"expo 3s",
		]);
	});

	it("runs shortest first when one job runs at a time", () => {
		expect(orderForFirstFailure(longestFirst, 1)).toEqual(
			longestFirst.toReversed(),
		);
	});
});
