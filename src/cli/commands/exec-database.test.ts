import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDevEnv } from "../../loader";
import { databaseTarget, pointEnvAtDatabase } from "./database-url";
import { databaseOverrides } from "./exec-database";

describe("pointEnvAtDatabase", () => {
	const target = databaseTarget(
		8732,
		"app",
		"postgresql://postgres:postgres@192.168.1.4:8732/app",
	);

	it("rewrites only URLs to the same host, port and database", () => {
		expect(
			pointEnvAtDatabase(
				{
					DATABASE_URL: "postgresql://u:p@localhost:8732/app?schema=public",
					DIRECT: "postgres://u:p@127.0.0.1:8732/app",
					LAN: "postgresql://u:p@192.168.1.4:8732/app",
					SHADOW: "postgresql://u:p@localhost:8732/app_shadow",
					OTHER_PORT: "postgresql://u:p@localhost:5432/app",
					REMOTE: "postgresql://u:p@db.example.com:8732/app",
					NOT_A_URL: "app",
					MALFORMED: "postgresql://u:p@localhost:8732/%E0%A4%A",
					UNSET: undefined,
				},
				target,
				"scratch_perf",
			),
		).toEqual({
			DATABASE_URL:
				"postgresql://u:p@localhost:8732/scratch_perf?schema=public",
			DIRECT: "postgres://u:p@127.0.0.1:8732/scratch_perf",
			LAN: "postgresql://u:p@192.168.1.4:8732/scratch_perf",
		});
	});
});

describe("databaseOverrides", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	async function environment() {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-execdb-")));
		roots.push(root);
		writeFileSync(join(root, "package.json"), "{}");
		writeFileSync(
			join(root, "dev.config.ts"),
			"export default {projectPrefix:'execdb',services:{postgres:{port:5432}},apps:{api:{port:3000,devCommand:false}},env:(_p,urls)=>({DATABASE_URL_DIRECT:urls.postgres,SHADOW_DATABASE_URL:urls.postgres+'_shadow'}),prisma:{}};",
		);
		const env = await loadDevEnv({ cwd: root, readOnly: true });
		return { env, port: (env.ports as Record<string, number>).postgres };
	}

	it("points every variable at the checkout's database to the named one", async () => {
		const { env, port } = await environment();
		const asked: string[] = [];

		const overrides = await databaseOverrides(env, "api", "scratch_perf", {
			exists: async (url, name) => {
				asked.push(`${url} ${name}`);
				return true;
			},
			inherited: {
				EXPORTED_URL: `postgresql://me:pw@localhost:${port}/postgres`,
			},
		});

		const url = `postgresql://postgres:postgres@localhost:${port}/scratch_perf`;
		expect(overrides).toEqual({
			EXPORTED_URL: `postgresql://me:pw@localhost:${port}/scratch_perf`,
			POSTGRES_URL: url,
			POSTGRES_LOOPBACK_URL: url,
			DATABASE_URL: url,
			DATABASE_URL_DIRECT: url,
		});
		expect(asked).toEqual([
			`postgresql://postgres:postgres@localhost:${port}/postgres scratch_perf`,
		]);
	});

	it("refuses a database that does not exist, naming the command that makes it", async () => {
		const { env } = await environment();

		const failure = databaseOverrides(env, undefined, "scratch_perf", {
			exists: async () => false,
			inherited: {},
		});

		await expect(failure).rejects.toThrow(
			'Database "scratch_perf" does not exist in postgres',
		);
		await failure.catch((error: { hints: string[] }) =>
			expect(error.hints[0]).toBe(
				"Create it: buncargo sql --create-scratch=perf",
			),
		);
	});

	it("refuses when the database cannot be reached", async () => {
		const { env } = await environment();

		await expect(
			databaseOverrides(env, undefined, "scratch_perf", {
				exists: async () => undefined,
				inherited: {},
			}),
		).rejects.toThrow("Could not reach postgres");
	});
});
