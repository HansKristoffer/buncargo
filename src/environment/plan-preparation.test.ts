import { describe, expect, it } from "bun:test";
import { resolveApps, resolveServices } from "../config/resolve";
import { PRISMA_MIGRATE_DEPLOY } from "../prisma/migrations-for";
import {
	PRISMA_DB_PUSH,
	type PreparationOptions,
	planPreparation,
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
});
