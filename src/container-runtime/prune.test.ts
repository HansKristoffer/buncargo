import { describe, expect, it } from "bun:test";
import { CHECKOUT_HOLD, LIVE, type RunEntry } from "../core/run-registry";
import type { BuncargoContainer, BuncargoVolume } from "../types";
import { orphanedVolumes, planVolumePrune } from "./prune";

function volume(name: string, project?: string): BuncargoVolume {
	return { name, ...(project ? { project } : {}), runtime: "docker" };
}

function container(project: string): BuncargoContainer {
	return {
		id: `${project}-id`,
		name: project,
		state: "exited",
		status: "Exited (0) 2 hours ago",
		ports: "",
		project,
		root: "/repo",
		worktree: "",
		service: "db",
		runtime: "docker",
	};
}

function run(projectName: string, extra: Partial<RunEntry> = {}): RunEntry {
	return {
		sessionId: projectName,
		projectPrefix: "demo",
		projectName,
		root: "/repo",
		worktree: null,
		pid: 1,
		startedAt: "2026-09-22T10:00:00.000Z",
		updatedAt: "2026-09-22T10:00:00.000Z",
		lifecycle: LIVE,
		hold: CHECKOUT_HOLD,
		hosts: null,
		cli: { program: "bun" },
		apps: [],
		services: [{ name: "db", status: "ready" }],
		...extra,
	};
}

describe("planVolumePrune", () => {
	it("proposes only the volume of a deleted checkout that nothing else refers to", () => {
		const reports = planVolumePrune({
			volumes: [
				volume("gone_data", "gone"),
				volume("running_data", "running"),
				volume("held_data", "held"),
				volume("stray_data"),
			],
			containers: [container("running")],
			runs: [
				run("held", {
					lifecycle: { state: "released", at: "2026-09-22T10:00:00.000Z" },
				}),
			],
			checkouts: [
				{ projectName: "gone", root: "/gone", deleted: true },
				{ projectName: "running", root: "/gone-too", deleted: true },
				{ projectName: "held", root: "/gone-also", deleted: true },
			],
		});
		expect(
			reports.map((report) => [report.volume.name, report.verdict.kind]),
		).toEqual([
			["gone_data", "orphaned"],
			["running_data", "in-use"],
			["held_data", "in-use"],
			["stray_data", "unattributed"],
		]);
		expect(orphanedVolumes(reports)).toEqual(["gone_data"]);
	});

	it("keeps an idle checkout's volume, because `dev --down` is not `delete my database`", () => {
		// Containers removed and the entry retired: the checkout is still
		// there and its data has to survive until somebody says otherwise.
		const reports = planVolumePrune({
			volumes: [volume("myapp_postgres_data", "myapp")],
			containers: [],
			runs: [],
			checkouts: [{ projectName: "myapp", root: "/repo" }],
		});
		expect(reports[0]?.verdict).toEqual({
			kind: "in-use",
			reason: "its checkout /repo still exists",
		});
	});

	it("keeps a volume no claim names: absence of a claim is not evidence", () => {
		// What an unreadable `offsets.json` looks like to the planner: no
		// claims at all, and every idle checkout's database with nothing on it.
		const reports = planVolumePrune({
			volumes: [volume("myapp_postgres_data", "myapp")],
			containers: [],
			runs: [],
			checkouts: [],
		});
		expect(orphanedVolumes(reports)).toEqual([]);
	});

	it("keeps a deleted checkout's volume while another checkout claims its project", () => {
		const reports = planVolumePrune({
			volumes: [volume("shared_data", "shared")],
			containers: [],
			runs: [],
			checkouts: [
				{ projectName: "shared", root: "/gone", deleted: true },
				{ projectName: "shared", root: "/repo" },
			],
		});
		expect(orphanedVolumes(reports)).toEqual([]);
	});

	it("with deletedFor, proposes only volumes of checkouts first found deleted that long ago", () => {
		// `prune --older-than` and the sweep's own wait before it removes.
		const DAY = 86_400_000;
		const now = Date.parse("2026-11-11T00:00:00.000Z");
		const seen = (days: number) => new Date(now - days * DAY).toISOString();
		const reports = planVolumePrune({
			volumes: [
				volume("old_data", "old"),
				volume("recent_data", "recent"),
				volume("unstamped_data", "unstamped"),
			],
			containers: [],
			runs: [],
			checkouts: [
				{
					projectName: "old",
					root: "/old",
					deleted: true,
					deletedSeenAt: seen(8),
				},
				{
					projectName: "recent",
					root: "/recent",
					deleted: true,
					deletedSeenAt: seen(1),
				},
				{ projectName: "unstamped", root: "/unstamped", deleted: true },
			],
			deletedFor: { ms: 7 * DAY, now },
		});
		expect(orphanedVolumes(reports)).toEqual(["old_data"]);
		expect(reports[1]?.verdict.reason).toBe(
			"its checkout /recent was found deleted less than 7d ago",
		);
	});

	it("never proposes a volume the runtime would not attribute", () => {
		const reports = planVolumePrune({
			volumes: [volume("apple-volume-with-dashes")],
			containers: [],
			runs: [],
			checkouts: [],
		});
		expect(reports[0]?.verdict.kind).toBe("unattributed");
		expect(orphanedVolumes(reports)).toEqual([]);
	});
});
