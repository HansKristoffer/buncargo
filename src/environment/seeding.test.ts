import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevEnvVarsApi } from "./env-vars";
import {
	resolveBunSeedSpecifier,
	runSeedCommand,
	runSeedIfNeeded,
	type SeedContext,
} from "./seeding";
import { TERMINAL_OUTPUT } from "./status-output";

describe("resolveBunSeedSpecifier", () => {
	it("extracts a Bun script path", () => {
		expect(resolveBunSeedSpecifier("bun run ./scripts/seed.ts")).toBe(
			"./scripts/seed.ts",
		);
		expect(resolveBunSeedSpecifier("bun ./scripts/seed.ts")).toBe(
			"./scripts/seed.ts",
		);
	});

	it("ignores package.json script names", () => {
		expect(resolveBunSeedSpecifier("bun run db:seed")).toBeUndefined();
	});
});

function stubSeedContext(input: {
	root: string;
	command: string;
	check?: () => Promise<boolean>;
}): {
	ctx: SeedContext;
	envVars: DevEnvVarsApi;
} {
	const ctx: SeedContext = {
		root: input.root,
		urls: {},
		output: TERMINAL_OUTPUT,
		config: { seed: { command: input.command, check: input.check } },
	};
	const envVars = {
		buildEnvVars: () => ({}),
		resolveSecrets: async () => ({}),
		getHookContext: () => ({}),
		exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	} as unknown as DevEnvVarsApi;
	return { ctx, envVars };
}

describe("runSeedIfNeeded", () => {
	it("reports a missing seed block instead of guessing a command", async () => {
		const ctx: SeedContext = {
			root: "/",
			urls: {},
			output: TERMINAL_OUTPUT,
			config: {},
		};
		const envVars = {} as unknown as DevEnvVarsApi;

		expect(await runSeedIfNeeded(ctx, envVars)).toEqual({
			status: "not-configured",
		});
	});

	it("honors seed.check unless force is set", async () => {
		const { ctx, envVars } = stubSeedContext({
			root: tmpdir(),
			command: "exit 0",
			check: async () => false,
		});

		expect(
			(await runSeedIfNeeded(ctx, envVars, { verbose: false })).status,
		).toBe("not-needed");
		expect(
			(await runSeedIfNeeded(ctx, envVars, { verbose: false, force: true }))
				.status,
		).toBe("succeeded");
	});

	it("hands each line of the seed's output to onOutputLine", async () => {
		const { ctx, envVars } = stubSeedContext({
			root: tmpdir(),
			command: "echo planted; echo oops >&2",
		});
		const lines: string[] = [];

		const outcome = await runSeedIfNeeded(ctx, envVars, {
			onOutputLine: (line) => lines.push(line),
		});

		expect(outcome.status).toBe("succeeded");
		expect(lines.sort()).toEqual(["oops", "planted"]);
	});

	it("returns the failed outcome without throwing", async () => {
		const { ctx, envVars } = stubSeedContext({
			root: tmpdir(),
			command: "exit 3",
		});

		const outcome = await runSeedIfNeeded(ctx, envVars, { verbose: false });
		expect(outcome.status).toBe("failed");
		if (outcome.status === "failed") {
			expect(outcome.result.exitCode).toBe(3);
		}
	});

	// An agent re-ran a 200-second `dev` twice with `grep -B5 -A25` to find
	// which seeder failed: the failure now carries the seed's last lines.
	it("keeps the last lines of a failed seed, in order", async () => {
		const { ctx, envVars } = stubSeedContext({
			root: tmpdir(),
			command:
				"for i in $(seq 1 30); do echo step $i; done; echo 'dataQualityDuplicatesSeeder: MISSING_SECRETS'; exit 1",
		});
		const lines: string[] = [];

		const outcome = await runSeedIfNeeded(ctx, envVars, {
			onOutputLine: (line) => lines.push(line),
		});

		if (outcome.status !== "failed") throw new Error(outcome.status);
		expect(outcome.command).toContain("seq 1 30");
		expect(outcome.tail).toHaveLength(20);
		expect(outcome.tail.at(-1)).toBe(
			"dataQualityDuplicatesSeeder: MISSING_SECRETS",
		);
		expect(outcome.tail[0]).toBe("step 12");
		expect(lines).toHaveLength(31);

		const quiet = await runSeedIfNeeded(ctx, envVars, { verbose: false });
		if (quiet.status !== "failed") throw new Error(quiet.status);
		expect(quiet.tail.at(-1)).toBe(
			"dataQualityDuplicatesSeeder: MISSING_SECRETS",
		);
	});
});

describe("runSeedCommand", () => {
	it("exits after a Bun seed module that leaves open handles", async () => {
		const root = join(tmpdir(), `buncargo-seed-${Date.now()}`);
		mkdirSync(root, { recursive: true });
		const seedPath = join(root, "seed.ts");
		writeFileSync(
			seedPath,
			`await Bun.write(${JSON.stringify(join(root, "ok.txt"))}, "ok")\nsetInterval(() => {}, 60_000)\n`,
		);

		try {
			const result = await runSeedCommand({
				command: "bun run ./seed.ts",
				root,
				envVars: {},
				verbose: false,
			});
			expect(result.exitCode).toBe(0);
			expect(await Bun.file(join(root, "ok.txt")).text()).toBe("ok");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
