import { expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrationsSequentially } from "../environment/migrations";
import {
	appliedMigrationCount,
	type MigrationRow,
	readMigrationRows,
} from "./migrations-applied";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "buncargo-applied-"));
	const dir = join(root, "db", "schema", "migrations");
	await mkdir(join(dir, "20260101_initial"), { recursive: true });
	await writeFile(join(dir, "20260101_initial", "migration.sql"), "SELECT 1;");
	await mkdir(join(dir, "not-a-migration"));
	return {
		root,
		dir,
		input: {
			root,
			prisma: { cwd: "db", migrations: "schema/migrations" },
			serviceKey: "postgres",
			service: { port: 5432 },
			url: "postgresql://postgres:postgres@127.0.0.1:5432/dev",
		},
	};
}
const applied: MigrationRow = {
	migration_name: "20260101_initial",
	finished_at: new Date(),
	rolled_back_at: null,
};

for (const scenario of [
	"applied",
	"new",
	"fresh",
	"failed",
	"rolled-back",
	"unreadable",
	"custom-service",
] as const) {
	it(`migration deploy shortcut: ${scenario}`, async () => {
		const { root, dir, input } = await fixture();
		try {
			if (scenario === "new") {
				await mkdir(join(dir, "20260202_next"));
				await writeFile(
					join(dir, "20260202_next", "migration.sql"),
					"SELECT 2;",
				);
			}
			if (scenario === "unreadable") await rm(dir, { recursive: true });
			if (scenario === "custom-service") input.serviceKey = "custom";
			const read = async () => {
				if (scenario === "fresh")
					throw new Error('relation "_prisma_migrations" does not exist');
				if (scenario === "failed") return [{ ...applied, finished_at: null }];
				if (scenario === "rolled-back")
					return [{ ...applied, rolled_back_at: new Date() }];
				return [applied];
			};
			const spawns: string[] = [];
			await runMigrationsSequentially(
				[{ name: "prisma", command: "deploy" }],
				async (command) => {
					spawns.push(command);
					return { exitCode: 0, stdout: "", stderr: "" };
				},
				async () => (await appliedMigrationCount(input, read)) !== undefined,
			);
			expect(spawns).toEqual(scenario === "applied" ? [] : ["deploy"]);
			if (scenario === "applied")
				expect(await appliedMigrationCount(input, read)).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

it("bounds a real SQL connection failure and honours cancellation", async () => {
	const { root, input } = await fixture();
	const probe = Bun.serve({
		port: 0,
		fetch: () => new Response("not postgres"),
	});
	const port = probe.port;
	probe.stop(true);
	input.url = `postgresql://postgres:postgres@127.0.0.1:${port}/dev`;
	try {
		expect(await appliedMigrationCount(input)).toBeUndefined();
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			readMigrationRows(input.url, controller.signal),
		).rejects.toThrow("cancelled");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("executes the migration query through Bun SQL and falls back on an absent table", async () => {
	const { Database } = await import("bun:sqlite");
	const { root, input } = await fixture();
	const file = join(root, "migration-state.sqlite");
	const db = new Database(file);
	try {
		const read = () => readMigrationRows(`sqlite://${file}`);
		expect(await appliedMigrationCount(input, read)).toBeUndefined();
		db.run(
			"CREATE TABLE _prisma_migrations (migration_name TEXT, finished_at TEXT, rolled_back_at TEXT)",
		);
		db.run("INSERT INTO _prisma_migrations VALUES (?, ?, NULL)", [
			applied.migration_name,
			"2026-01-01",
		]);
		expect(await appliedMigrationCount(input, read)).toBe(1);
		db.run("INSERT INTO _prisma_migrations VALUES ('failed', NULL, NULL)");
		expect(await appliedMigrationCount(input, read)).toBeUndefined();
	} finally {
		db.close();
		await rm(root, { recursive: true, force: true });
	}
});
