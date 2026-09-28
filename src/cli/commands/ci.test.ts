import { describe, expect, it } from "bun:test";
import { parseCiArgs } from "./ci";
import { withAppendedArgs } from "./exec";

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
