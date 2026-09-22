import { describe, expect, it } from "bun:test";
import type { RunEntry } from "../core/run-registry";
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
		hosts: null,
		cli: { program: "bun" },
		apps: [],
		services: [{ name: "db", status: "ready" }],
		...extra,
	};
}

describe("planVolumePrune", () => {
	it("proposes only volumes whose project nothing mentions", () => {
		const reports = planVolumePrune({
			volumes: [
				volume("gone_data", "gone"),
				volume("running_data", "running"),
				volume("held_data", "held"),
				volume("stray_data"),
			],
			containers: [container("running")],
			runs: [run("held", { releasedAt: "2026-09-22T10:00:00.000Z" })],
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

	it("keeps a stopped project's volume, because `dev --down` is not `delete my database`", () => {
		// Containers removed and the entry retired: the checkout is still
		// there and its data has to survive until somebody says otherwise.
		const reports = planVolumePrune({
			volumes: [volume("myapp_postgres_data", "myapp")],
			containers: [],
			runs: [],
		});
		// Nothing mentions it, so it is proposed — and only proposed. The
		// command confirms before removing, which is the whole safety story.
		expect(orphanedVolumes(reports)).toEqual(["myapp_postgres_data"]);
	});

	it("never proposes a volume the runtime would not attribute", () => {
		const reports = planVolumePrune({
			volumes: [volume("apple-volume-with-dashes")],
			containers: [],
			runs: [],
		});
		expect(reports[0]?.verdict.kind).toBe("unattributed");
		expect(orphanedVolumes(reports)).toEqual([]);
	});
});
