import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execAsync } from "../../core/process";
import { startFakeInfisical } from "../../core/secrets/fake-infisical.testing";
import { parseCiArgs } from "./ci";
import { withAppendedArgs } from "./exec";

const cli = [process.execPath, resolve(import.meta.dir, "../bin.ts")];

describe("parseCiArgs", () => {
	it("splits options from the command at --", () => {
		const parsed = parseCiArgs([
			"--migrate",
			"--services=postgres, redis",
			"--",
			"bun",
			"test",
			"--bail",
		]);
		expect(parsed.migrate).toBe(true);
		expect(parsed.seed).toBe(false);
		expect(parsed.services).toEqual(["postgres", "redis"]);
		expect(parsed.command).toEqual(["bun", "test", "--bail"]);
		expect(parsed.errors).toEqual([]);
	});

	it("allows no command, for a migrations/seed-only check", () => {
		expect(parseCiArgs(["--seed"]).command).toEqual([]);
	});

	it("rejects unknown flags and stray arguments", () => {
		expect(parseCiArgs(["--nope", "bun"]).errors).toEqual([
			"Unknown flag: --nope",
			"Unexpected argument before --: bun",
		]);
	});
});

describe("withAppendedArgs", () => {
	it("keeps a bare command a shell string", () => {
		expect(withAppendedArgs("bun scripts/seed.ts", [])).toBe(
			"bun scripts/seed.ts",
		);
	});

	// Positional parameters: the shell never re-parses what was passed.
	it("passes extra args to sh as positional parameters", () => {
		expect(withAppendedArgs("bun seed.ts", ["a b", "$HOME"])).toEqual([
			"sh",
			"-c",
			'bun seed.ts "$@"',
			"sh",
			"a b",
			"$HOME",
		]);
	});
});

it("runs the command without fetching app or config-level secrets", async () => {
	const infisical = startFakeInfisical();
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-ci-")));
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
	writeFileSync(
		join(root, "dev.config.ts"),
		`export default {projectPrefix:'cisec',services:{},apps:{api:{port:3000,devCommand:false,secrets:{projectId:'api'}}},secrets:{projectId:'shared',siteUrl:${JSON.stringify(infisical.siteUrl)}}};`,
	);

	try {
		const result = await execAsync(
			[
				...cli,
				"ci",
				"--migrate",
				"--",
				process.execPath,
				"-e",
				"console.log('ran')",
			],
			root,
			{
				HOME: infisical.home,
				BUNCARGO_INFISICAL_PATH: infisical.cliPath,
			},
		);
		expect(result.stdout).toContain("ran");
		expect(infisical.requests).toEqual([]);
		expect(infisical.cliCalls()).toEqual([]);
	} finally {
		infisical.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
