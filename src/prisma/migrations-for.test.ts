import { expect, it } from "bun:test";
import { migrationsFor } from "./migrations-for";

it("runs prisma migrate deploy before the declared migrations, only with its database", () => {
	expect(
		migrationsFor({
			prisma: { cwd: "db", service: "main" },
			migrations: [{ name: "clickhouse", command: "bun ch:migrate" }],
		}),
	).toEqual([
		{
			name: "prisma",
			command: "bunx --no-install prisma migrate deploy",
			cwd: "db",
			requiredServices: ["main"],
		},
		{ name: "clickhouse", command: "bun ch:migrate" },
	]);
	expect(migrationsFor({})).toEqual([]);
});
