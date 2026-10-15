import { describe, expect, it } from "bun:test";
import {
	defaultTypecheckConcurrency,
	LOCAL_TYPECHECK_CONCURRENCY_CAP,
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
