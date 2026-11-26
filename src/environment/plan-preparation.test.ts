import { describe, expect, it } from "bun:test";
import { resolveApps, resolveServices } from "../config/resolve";
import { PRISMA_MIGRATE_DEPLOY } from "../prisma/migrations-for";
import {
	PRISMA_DB_PUSH,
	type PreparationOptions,
	planPreparation,
	seedSkippedLine,
} from "./plan-preparation";

const services = resolveServices({
	db: { port: 5432 },
	cache: { port: 6379 },
	search: { port: 7700, afterPreparation: true },
});
const apps = resolveApps({ web: { port: 3000, devCommand: "bun dev" } });
const config = {
	prisma: { service: "db" },
	migrations: [
		{
			name: "cache-schema",
			command: "migrate-cache",
			requiredServices: ["cache"],
		},
		{ name: "everything", command: "migrate-all" },
	],
	seed: { command: "seed", beforeApps: false, requiredServices: ["db"] },
};
const all: PreparationOptions = {
	prepare: "all",
	seed: "auto",
	schema: "migrate",
	spawn: true,
};

describe("planPreparation", () => {
	it("runs Prisma first, then each migration whose services are selected", () => {
		const plan = planPreparation(
			config,
			services,
			{ requiredServiceKeys: ["db"], apps },
			all,
		);
		expect(plan.migrations.map(({ name, command }) => [name, command])).toEqual(
			[
				["prisma", PRISMA_MIGRATE_DEPLOY],
				["everything", "migrate-all"],
			],
		);
		expect(plan.prismaSelected).toBe(true);
	});

	it("pushes the schema in place of the deploy, keeping the other migrations", () => {
		const plan = planPreparation(
			config,
			services,
			{ requiredServiceKeys: ["db", "cache"], apps },
			{ ...all, schema: "push" },
		);
		expect(plan.migrations.map(({ command }) => command)).toEqual([
			PRISMA_DB_PUSH,
			"migrate-cache",
			"migrate-all",
		]);
	});

	it("overlaps the seed with the apps only when apps spawn and nothing waits on preparation", () => {
		const plan = (
			requiredServiceKeys: string[],
			options: Partial<PreparationOptions> = {},
		) =>
			planPreparation(
				config,
				services,
				{ requiredServiceKeys, apps },
				{ ...all, ...options },
			).seedOverlaps;

		expect(plan(["db"])).toBe(true);
		expect(plan(["db"], { spawn: false })).toBe(false);
		expect(plan(["db"], { seed: "force" })).toBe(false);
		// `search` comes up after the seed, so the seed cannot wait for the apps.
		expect(plan(["db", "search"])).toBe(false);
	});

	it("starts every selected service at once and reads no secrets in containers-only mode", () => {
		const plan = planPreparation(
			config,
			services,
			{ requiredServiceKeys: ["db", "search"], apps },
			{ ...all, prepare: "containers" },
		);
		expect(Object.keys(plan.earlyServices)).toEqual(["db", "search"]);
		expect(plan.lateServices).toEqual({});
		expect(plan.secrets).toBeUndefined();
	});

	it("reads the seed's scope only when the seed may run", () => {
		const includesSeed = (seed: "auto" | "force" | "skip") =>
			planPreparation(
				config,
				services,
				{ requiredServiceKeys: ["db"], apps },
				{ ...all, seed },
			).secrets?.includeSeed;

		expect(includesSeed("auto")).toBe(true);
		expect(includesSeed("force")).toBe(true);
		expect(includesSeed("skip")).toBe(false);
	});

	it("plans post-app seeding when seed.afterApps prerequisites are selected", () => {
		const firebaseApps = resolveApps({
			firebase: { port: 4000, devCommand: "firebase emulators:start" },
			web: { port: 3000, devCommand: "bun dev" },
		});
		const afterAppsConfig = {
			seed: { command: "plantr", afterApps: ["firebase"] },
		};

		// App-only config (no Docker services) still selects the post-app seed.
		const selected = planPreparation(
			afterAppsConfig,
			{},
			{ requiredServiceKeys: [], apps: firebaseApps },
			all,
		);
		expect(selected.seedSelected).toBe(true);
		expect(selected.seedAfterApps).toEqual(["firebase"]);
		expect(selected.seedBeforeOtherApps).toBe(true);
		expect(selected.seedOverlaps).toBe(false);
		expect(selected.secrets?.includeSeed).toBe(true);

		// Missing prerequisite app skips post-app seeding.
		const withoutPrereq = planPreparation(
			afterAppsConfig,
			{},
			{ requiredServiceKeys: [], apps: { web: firebaseApps.web } },
			all,
		);
		expect(withoutPrereq.seedSelected).toBe(false);
		expect(withoutPrereq.seedAfterApps).toBeUndefined();
		expect(withoutPrereq.secrets?.includeSeed).toBe(false);
		expect(withoutPrereq.seedMissingApps).toEqual(["firebase"]);
		expect(seedSkippedLine(["firebase"], ["web"])).toBe(
			"Seed skipped: seed.afterApps waits for app firebase, which this run does not start. To seed, run `buncargo dev --seed --apps=web,firebase`, or `buncargo dev --seed` without --apps or --profile.",
		);
		expect(selected.seedMissingApps).toEqual([]);

		// `spawn: false` skips post-app seeding (apps do not start).
		const noSpawn = planPreparation(
			afterAppsConfig,
			{},
			{ requiredServiceKeys: [], apps: firebaseApps },
			{ ...all, spawn: false },
		);
		expect(noSpawn.seedSelected).toBe(false);
		expect(noSpawn.seedAfterApps).toBeUndefined();
		// Nothing left out: the apps are selected, just not spawned.
		expect(noSpawn.seedMissingApps).toEqual([]);

		// `beforeApps: false` preserves overlap after prerequisite apps are ready.
		const overlap = planPreparation(
			{
				seed: { command: "plantr", afterApps: ["firebase"], beforeApps: false },
			},
			{},
			{ requiredServiceKeys: [], apps: firebaseApps },
			all,
		);
		expect(overlap.seedAfterApps).toEqual(["firebase"]);
		expect(overlap.seedBeforeOtherApps).toBe(false);

		// Explicit `requiredServices` is still enforced alongside `afterApps`.
		const withService = {
			seed: {
				command: "plantr",
				afterApps: ["firebase"],
				requiredServices: ["db"],
			},
		};
		expect(
			planPreparation(
				withService,
				services,
				{ requiredServiceKeys: [], apps: firebaseApps },
				all,
			).seedSelected,
		).toBe(false);
		expect(
			planPreparation(
				withService,
				services,
				{ requiredServiceKeys: ["db"], apps: firebaseApps },
				all,
			).seedSelected,
		).toBe(true);
	});
});
