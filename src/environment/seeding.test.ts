import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevEnvContext } from "./context";
import type { DevEnvVarsApi } from "./env-vars";
import {
	resolveBunSeedSpecifier,
	runSeedCommand,
	runSeedIfNeeded,
} from "./seeding";

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

type AnyServices = Record<string, never>;
type AnyApps = Record<string, never>;

function stubSeedContext(input: {
	root: string;
	command: string;
	check?: () => Promise<boolean>;
}): {
	ctx: DevEnvContext<AnyServices, AnyApps>;
	envVars: DevEnvVarsApi<AnyServices, AnyApps>;
} {
	const ctx = {
		root: input.root,
		urls: {},
		config: { seed: { command: input.command, check: input.check } },
	} as unknown as DevEnvContext<AnyServices, AnyApps>;
	const envVars = {
		buildEnvVars: () => ({}),
		getHookContext: () => ({}),
		exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
	} as unknown as DevEnvVarsApi<AnyServices, AnyApps>;
	return { ctx, envVars };
}

describe("runSeedIfNeeded", () => {
	it("reports a missing seed block instead of guessing a command", async () => {
		const ctx = { config: {} } as unknown as DevEnvContext<
			AnyServices,
			AnyApps
		>;
		const envVars = {} as unknown as DevEnvVarsApi<AnyServices, AnyApps>;

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
