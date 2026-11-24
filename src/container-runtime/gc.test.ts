import { describe, expect, it } from "bun:test";
import type { CheckoutPresence } from "../core/checkout-presence";
import type { OffsetClaim } from "../core/offset-claims";
import { runEntry } from "../core/run-registry.testing";
import type { BuncargoContainer, BuncargoVolume } from "../types";
import { planGc, staleDeletedClaims } from "./gc";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const HOUR = 3_600_000;

function container(
	project: string,
	root: string,
	state = "running",
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

function volume(name: string, project?: string): BuncargoVolume {
	return { name, project, runtime: "docker" };
}

function claim(
	projectName: string,
	offset: number,
	usedAt: string,
): OffsetClaim {
	return {
		offset,
		ports: [5432 + offset],
		projectName,
		updatedAt: usedAt,
		usedAt,
	};
}

describe("planGc", () => {
	const present = "/work/live";
	const idleRoot = "/work/idle";
	const recentRoot = "/work/recent";
	const gone = "/work/gone";
	const unreadable = "/other/unreadable";

	const presence = (root: string): CheckoutPresence => {
		if (root === gone) return "deleted";
		if (root === unreadable) return "unknown";
		return "present";
	};

	it("plans deleted-checkout stacks/volumes/claims and idle unowned stacks while keeping live, recent, unreadable and foreign state", () => {
		const oldIso = new Date(NOW - 4 * HOUR).toISOString();
		const recentIso = new Date(NOW - 10 * 60_000).toISOString();
		const claims: Record<string, OffsetClaim> = {
			[present]: claim("app-live", 100, oldIso),
			[idleRoot]: claim("app-idle", 200, oldIso),
			[recentRoot]: claim("app-recent", 300, recentIso),
			[gone]: claim("app-gone", 400, oldIso),
			[unreadable]: claim("app-unreadable", 500, oldIso),
		};
		const liveRun = runEntry({
			sessionId: "s-live",
			projectName: "app-live",
			root: present,
			pid: process.pid,
		});

		const plan = planGc({
			containers: [
				container("app-live", present, "running"),
				container("app-idle", idleRoot, "running"),
				container("app-recent", recentRoot, "running"),
				container("app-gone", gone, "running"),
				container("app-unreadable", unreadable, "running"),
				container("foreign-stack", gone, "running"),
			],
			volumes: [
				volume("app-live_pg", "app-live"),
				volume("app-idle_pg", "app-idle"),
				volume("app-gone_pg", "app-gone"),
				volume("app-unreadable_pg", "app-unreadable"),
				volume("foreign_pg", "foreign-stack"),
			],
			runs: [liveRun],
			alive: (run) => run.sessionId === "s-live",
			claims,
			checkoutPresence: presence,
			lastActivityAt: (group) => {
				const entry = claims[group.root];
				return entry ? Date.parse(entry.usedAt) : undefined;
			},
			now: NOW,
			idleLimitMs: 2 * HOUR,
		});

		// Stops deleted checkout and idle unowned stack; never touches live,
		// recent, unreadable, or foreign stacks.
		expect(plan.stacks.map((s) => s.projectName).sort()).toEqual([
			"app-gone",
			"app-idle",
		]);
		// Only the deleted checkout's volume is proposed; the idle existing
		// checkout's database volume is kept.
		expect(plan.volumes.map((v) => v.name)).toEqual(["app-gone_pg"]);
		// Only the deleted checkout's claim is pruned.
		expect(plan.claims.map((c) => c.key)).toEqual([gone]);
	});

	it("plans orphaned integration stacks on deleted checkouts too", () => {
		const oldIso = new Date(NOW - 4 * HOUR).toISOString();
		const deadIntegrationRun = runEntry({
			sessionId: "s-supa",
			projectName: "app-supa",
			root: gone,
			pid: 1,
			stacks: [{ name: "supabase", down: ["supabase", "stop"] }],
		});

		const plan = planGc({
			containers: [],
			volumes: [],
			runs: [deadIntegrationRun],
			alive: () => false,
			claims: { [gone]: claim("app-supa", 600, oldIso) },
			checkoutPresence: presence,
			lastActivityAt: () => undefined,
			now: NOW,
			idleLimitMs: 2 * HOUR,
		});

		expect(plan.stacks).toEqual([
			{
				projectName: "app-supa",
				root: gone,
				runtime: "supabase",
				reason: "checkout deleted",
			},
		]);
		expect(plan.claims.map((c) => c.key)).toEqual([gone]);
	});
});

describe("staleDeletedClaims", () => {
	it("keeps a deleted checkout's claim while a run, container or volume still references its project", () => {
		const iso = new Date(NOW).toISOString();
		const claims: Record<string, OffsetClaim> = {
			"/gone/with-volume": claim("proj-vol", 100, iso),
			"/gone/with-container": claim("proj-ctr", 200, iso),
			"/gone/with-run": claim("proj-run", 250, iso),
			"/gone/clean": claim("proj-clean", 300, iso),
			"/present/active": claim("proj-live", 400, iso),
		};

		const stale = staleDeletedClaims({
			claims,
			checkoutPresence: (root) =>
				root.startsWith("/gone/") ? "deleted" : "present",
			remainingRuns: [{ projectName: "proj-run", root: "/gone/with-run" }],
			remainingContainers: [
				{ project: "proj-ctr", root: "/gone/with-container" },
			],
			remainingVolumes: [{ project: "proj-vol" }],
		});

		expect(stale.map((c) => c.key)).toEqual(["/gone/clean"]);
	});
});
