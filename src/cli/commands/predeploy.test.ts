import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execAsync } from "../../core/process";
import type { PredeployContext } from "../../types";
import { CliError } from "../errors";
import {
	type PredeployIo,
	predeployEnvironment,
	runPredeploy,
} from "./predeploy";

function io(
	env: NodeJS.ProcessEnv,
	results: Record<string, { exitCode: number; output?: string }[]> = {},
) {
	const ran: { command: string; cwd: string }[] = [];
	const slept: number[] = [];
	const logged: string[] = [];
	const value: PredeployIo = {
		env,
		run: async (command, cwd) => {
			ran.push({ command, cwd });
			const next = results[command]?.shift() ?? { exitCode: 0 };
			return { exitCode: next.exitCode, output: next.output ?? "" };
		},
		sleep: async (ms) => {
			slept.push(ms);
		},
		log: (message) => void logged.push(message),
	};
	return { io: value, ran, slept, logged };
}

const cli = resolve(import.meta.dir, "../bin.ts");
const PRISMA = "bunx --no-install prisma migrate deploy";
const config = {
	prisma: { cwd: "packages/prisma" },
	migrations: [{ name: "clickhouse", command: "bun ch:migrate" }],
	seed: { command: "bun run seed" },
};

describe("predeploy", () => {
	it("names the environment from the first variable set", () => {
		expect(predeployEnvironment({}, { NODE_ENV: "production" })).toEqual({
			environment: "production",
			production: true,
			named: true,
		});
		expect(
			predeployEnvironment(
				{},
				{ SECRETS_ENV: "staging", NODE_ENV: "production" },
			),
		).toEqual({ environment: "staging", production: false, named: true });
		expect(predeployEnvironment({}, {})).toEqual({
			environment: "dev",
			production: false,
			named: false,
		});
		expect(
			predeployEnvironment(
				{ environmentVars: ["APP_ENV"], production: ["live"] },
				{ APP_ENV: "live", NODE_ENV: "dev" },
			).production,
		).toBe(true);
	});

	it("migrates then seeds outside production", async () => {
		const run = io({ SECRETS_ENV: "staging" });
		await runPredeploy(
			"/repo",
			{ ...config, predeploy: { seed: true } },
			run.io,
		);
		expect(run.ran).toEqual([
			{ command: PRISMA, cwd: "/repo/packages/prisma" },
			{ command: "bun ch:migrate", cwd: "/repo" },
			{ command: "bun run seed", cwd: "/repo" },
		]);
	});

	it("never seeds production, and runs the hooks around the steps", async () => {
		const order: string[] = [];
		const run = io({ SECRETS_ENV: "prod" });
		await runPredeploy(
			"/repo",
			{
				...config,
				predeploy: {
					beforeMigrate: () => void order.push("before"),
					afterMigrate: async (ctx: PredeployContext) => {
						order.push(`after:${ctx.production}`);
						await ctx.exec("bun backfill", { cwd: "apps/api" });
					},
					afterSeed: () => void order.push("afterSeed"),
				},
			},
			run.io,
		);
		expect(order).toEqual(["before", "after:true", "afterSeed"]);
		expect(run.ran.map((step) => step.command)).toEqual([
			PRISMA,
			"bun ch:migrate",
			"bun backfill",
		]);
		expect(run.ran.at(-1)?.cwd).toBe("/repo/apps/api");
	});

	it("waits out a database with no free connection slots", async () => {
		const refused = {
			exitCode: 1,
			output: "FATAL: remaining connection slots are reserved for roles",
		};
		const run = io({}, { [PRISMA]: [refused, refused, { exitCode: 0 }] });
		await runPredeploy("/repo", { prisma: config.prisma }, run.io);
		expect(run.ran.filter((step) => step.command === PRISMA)).toHaveLength(3);
		expect(run.slept).toEqual([15_000, 15_000]);
	});

	it("fails at once on any other migration error, and after the last retry", async () => {
		const other = io({}, { [PRISMA]: [{ exitCode: 1, output: "P3009" }] });
		await expect(
			runPredeploy("/repo", { prisma: config.prisma }, other.io),
		).rejects.toBeInstanceOf(CliError);
		expect(other.slept).toEqual([]);

		const refused = {
			exitCode: 1,
			output: "remaining connection slots are reserved",
		};
		const capped = io({}, { [PRISMA]: [refused, refused, refused] });
		await expect(
			runPredeploy(
				"/repo",
				{
					prisma: config.prisma,
					predeploy: { retry: { attempts: 2, delayMs: 10 } },
				},
				capped.io,
			),
		).rejects.toThrow("migration prisma exited 1");
		expect(capped.slept).toEqual([10]);
	});

	it("never runs the dev seed.command unless predeploy.seed opts in, and says so", async () => {
		const run = io({ SECRETS_ENV: "staging" });

		await runPredeploy("/repo", { seed: config.seed }, run.io);

		expect(run.ran).toEqual([]);
		expect(run.logged).toContain(
			"predeploy.seed is not set: not seeding. Set it to a command, or to true for the dev seed.command.",
		);
	});

	it("refuses seed: true without a seed.command, before migrating", async () => {
		const run = io({ SECRETS_ENV: "staging" });

		const deploy = runPredeploy(
			"/repo",
			{ prisma: config.prisma, predeploy: { seed: true } },
			run.io,
		);

		await expect(deploy).rejects.toThrow("no seed.command to run");
		expect(run.ran).toEqual([]);
	});

	it("seeds with predeploy.seed instead of the dev seed, from the root", async () => {
		const run = io({ SECRETS_ENV: "staging" });
		await runPredeploy(
			"/repo",
			{
				seed: { command: "bun run seed", cwd: "apps/api" },
				predeploy: { seed: "bun run seed --allow-remote" },
			},
			run.io,
		);
		expect(run.ran).toEqual([
			{ command: "bun run seed --allow-remote", cwd: "/repo" },
		]);
	});

	it("does not seed an environment no variable names, and says so", async () => {
		const run = io({});

		await runPredeploy(
			"/repo",
			{ seed: config.seed, predeploy: { seed: true } },
			run.io,
		);

		expect(run.ran).toEqual([]);
		expect(run.logged).toContain(
			"no SECRETS_ENV or NODE_ENV names the environment: not seeding. Set one to seed it.",
		);
	});

	it("seeds only the environments in predeploy.seedIn", async () => {
		const inputs = {
			seed: config.seed,
			predeploy: { seed: true, seedIn: ["staging"] },
		} as const;
		const preview = io({ SECRETS_ENV: "eu-prod" });
		const staging = io({ SECRETS_ENV: "staging" });

		await runPredeploy("/repo", inputs, preview.io);
		await runPredeploy("/repo", inputs, staging.io);

		expect(preview.ran).toEqual([]);
		expect(preview.logged).toContain(
			'"eu-prod" is not in predeploy.seedIn: not seeding.',
		);
		expect(staging.ran.map((step) => step.command)).toEqual(["bun run seed"]);
	});

	// Every later deploy stops at the same migration until it is resolved.
	const recordedFailures = [
		{
			code: "P3009",
			output:
				"Error: P3009\n\nmigrate found failed migrations in the target database, new migrations will not be applied.\nThe `20250101000000_add_orders` migration started at 2025-01-01 10:00:00 UTC failed",
			name: "20250101000000_add_orders",
		},
		{
			code: "P3018",
			output:
				"Error: P3018\n\nA migration failed to apply.\n\nMigration name: 20250102_backfill\n\nDatabase error code: 23502",
			name: "20250102_backfill",
		},
	];
	for (const { code, output, name } of recordedFailures)
		it(`names the migration ${code} recorded as failed, with the command that unblocks deploys`, async () => {
			const failures: unknown[] = [];
			const run = io({}, { [PRISMA]: [{ exitCode: 1, output }] });

			const error = await runPredeploy(
				"/repo",
				{
					prisma: config.prisma,
					predeploy: {
						onFailure: (_ctx, failure) => void failures.push(failure),
					},
				},
				run.io,
			).catch((thrown: unknown) => thrown);

			expect(error).toBeInstanceOf(CliError);
			expect((error as CliError).hints.join("\n")).toContain(
				`bunx prisma migrate resolve --rolled-back ${name}`,
			);
			expect(failures).toEqual([
				{
					step: "migrate",
					migration: "prisma",
					failedPrismaMigration: name,
					message: "predeploy: migration prisma exited 1.",
				},
			]);
		});

	it("refuses a root config whose migrations are malformed, before running anything", async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "buncargo-predeploy-")),
		);
		writeFileSync(join(root, "package.json"), "{}");
		writeFileSync(
			join(root, "dev.config.ts"),
			"export default {projectPrefix:'pd',services:{},migrations:[{name:'m',command:3}]};",
		);

		try {
			const result = await execAsync(
				[process.execPath, cli, "predeploy"],
				root,
				{},
				{ throwOnError: false },
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("migrations.0.command");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
