import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseHealthCheck, installedPrismaMajor } from "./prisma";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

// migrate-check picks its `migrate diff` flags by this: Prisma 7 renamed and
// removed the ones 6 needs.
function project(): string {
	const dir = mkdtempSync(join(tmpdir(), "buncargo-prisma-"));
	dirs.push(dir);
	writeFileSync(join(dir, "package.json"), "{}");
	return dir;
}

it("reads the installed prisma major version", () => {
	const dir = project();
	mkdirSync(join(dir, "node_modules/prisma"), { recursive: true });
	writeFileSync(
		join(dir, "node_modules/prisma/package.json"),
		JSON.stringify({ name: "prisma", version: "6.19.3" }),
	);
	expect(installedPrismaMajor(dir)).toBe(6);
});

it("is undefined when prisma is not installed", () => {
	expect(installedPrismaMajor(project())).toBeUndefined();
});

it("waits for the database by its preset, whatever the service is keyed", () => {
	expect(
		databaseHealthCheck("db", {
			port: 5432,
			docker: { kind: "preset", preset: "postgres" },
		}),
	).toBe("pg_isready");
	expect(databaseHealthCheck("postgres", { port: 5432 })).toBe("pg_isready");
	expect(databaseHealthCheck("db", { port: 5432 })).toBe("tcp");
	expect(
		databaseHealthCheck("postgres", { port: 5432, healthCheck: false }),
	).toBe(false);
});
