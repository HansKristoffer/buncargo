import { describe, expect, it } from "bun:test";
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
		log: () => {},
	};
	return { io: value, ran, slept };
}

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
		});
		expect(
			predeployEnvironment(
				{},
				{ SECRETS_ENV: "staging", NODE_ENV: "production" },
			),
		).toEqual({ environment: "staging", production: false });
		expect(predeployEnvironment({}, {})).toEqual({
			environment: "dev",
			production: false,
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
		await runPredeploy("/repo", config, run.io);
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

	it("stops before seeding when the seed is turned off", async () => {
		const run = io({});
		await runPredeploy(
			"/repo",
			{ seed: config.seed, predeploy: { seed: false } },
			run.io,
		);
		expect(run.ran).toEqual([]);
	});
});
