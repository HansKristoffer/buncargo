import { describe, expect, it } from "bun:test";
import type { OffsetClaim } from "../core/offset-claims";
import type { RunEntry } from "../core/run-registry";
import type { BuncargoContainer, BuncargoVolume } from "../types";
import {
	ORPHAN_VOLUME_REPORT_INTERVAL_MS,
	orphanVolumeReporter,
} from "./orphan-report";
import type { ContainerRuntimeAdapter } from "./types";

// Existing paths, so `checkoutDeleted` sees them as present.
const PRESENT = import.meta.dir;
const GONE = `${import.meta.dir}/no-such-checkout-${Date.now()}`;

function volume(name: string, project?: string): BuncargoVolume {
	return { name, ...(project ? { project } : {}), runtime: "docker" };
}

function container(project: string): BuncargoContainer {
	return {
		id: `${project}-id`,
		name: project,
		state: "running",
		status: "Up 2 hours",
		ports: "",
		project,
		root: PRESENT,
		worktree: "",
		service: "db",
		runtime: "docker",
	};
}

function claim(projectName: string, suffix?: string): OffsetClaim {
	return { projectName, ...(suffix ? { suffix } : {}) } as OffsetClaim;
}

function setup(
	options: {
		volumes?: BuncargoVolume[];
		containers?: BuncargoContainer[];
		runs?: RunEntry[];
		claims?: Record<string, OffsetClaim>;
	} = {},
) {
	const runtime = {
		name: "docker",
		list: () => options.containers ?? [],
		listVolumes: async () => options.volumes ?? [],
	} as unknown as ContainerRuntimeAdapter;
	const logged: string[] = [];
	let clock = 0;
	const report = orphanVolumeReporter({
		log: (message) => logged.push(message),
		runtimes: () => [runtime],
		readRuns: async () => options.runs ?? [],
		claims: () => options.claims ?? {},
		now: () => clock,
	});
	return {
		logged,
		/** Report one pass, with the clock moved past the interval first. */
		pass: async (answered: "docker" | "none" = "docker") => {
			clock += ORPHAN_VOLUME_REPORT_INTERVAL_MS;
			await report(answered === "docker" ? ["docker"] : []);
		},
	};
}

describe("orphanVolumeReporter", () => {
	it("names the volumes whose project nothing mentions", async () => {
		const { logged, pass } = setup({
			volumes: [volume("old_postgres_data", "old")],
		});
		await pass();
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain("old_postgres_data");
		expect(logged[0]).toContain("nothing is removed automatically");
	});

	it("says nothing about volumes still in use", async () => {
		const { logged, pass } = setup({
			volumes: [
				volume("live_db", "live"),
				volume("ran_db", "ran"),
				volume("checked_db", "checked"),
			],
			containers: [container("live")],
			runs: [{ projectName: "ran" } as RunEntry],
			claims: { [PRESENT]: claim("checked") },
		});
		await pass();
		expect(logged).toEqual([]);
	});

	it("does not count a suffixed claim, or a deleted checkout's, as a checkout", async () => {
		const { logged, pass } = setup({
			volumes: [volume("ci_db", "demo-ci"), volume("gone_db", "gone")],
			claims: {
				[`${PRESENT}#ci`]: claim("demo-ci", "ci"),
				[GONE]: claim("gone"),
			},
		});
		await pass();
		expect(logged[0]).toContain("ci_db");
		expect(logged[0]).toContain("gone_db");
	});

	it("reports a standing set once, and again only when it changes", async () => {
		const scenario = setup({ volumes: [volume("a_db", "a")] });
		await scenario.pass();
		await scenario.pass();
		expect(scenario.logged).toHaveLength(1);
	});

	it("waits out the interval between reports", async () => {
		let clock = 0;
		const runtime = {
			name: "docker",
			list: () => [],
			listVolumes: async () => [volume("a_db", "a")],
		} as unknown as ContainerRuntimeAdapter;
		const logged: string[] = [];
		const report = orphanVolumeReporter({
			log: (message) => logged.push(message),
			runtimes: () => [runtime],
			readRuns: async () => [],
			claims: () => ({}),
			now: () => clock,
		});
		await report(["docker"]);
		clock += ORPHAN_VOLUME_REPORT_INTERVAL_MS - 1;
		await report(["docker"]);
		expect(logged).toHaveLength(1);
	});

	it("reports nothing when no runtime answered the pass", async () => {
		// Nothing was listed, so nothing can be called orphaned.
		const { logged, pass } = setup({
			volumes: [volume("a_db", "a")],
		});
		await pass("none");
		expect(logged).toEqual([]);
	});
});
