import { describe, expect, it } from "bun:test";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	positiveIntegerValidator,
	readStringFlag,
} from "./command-spec";

const spec: CommandSpec = {
	usage: "buncargo demo [options]",
	flags: [
		{ name: "--dry-run", kind: "boolean", description: "Do nothing" },
		{
			name: "--count",
			kind: "string",
			valueHint: "=N",
			description: "How many",
			validate: positiveIntegerValidator("--count"),
		},
	],
	examples: [{ command: "buncargo demo --dry-run", description: "Preview" }],
};

describe("findUnknownFlags", () => {
	it("accepts declared flags in both forms", () => {
		expect(findUnknownFlags(spec, ["--dry-run", "--count=2"])).toEqual([]);
		expect(findUnknownFlags(spec, ["--count", "2"])).toEqual([]);
	});

	it("reports undeclared long flags only", () => {
		expect(findUnknownFlags(spec, ["--nope", "-x", "value"])).toEqual([
			"--nope",
		]);
	});
});

describe("readStringFlag", () => {
	it("collects validation failures instead of throwing", () => {
		const errors: string[] = [];
		const flag = spec.flags[1];
		if (!flag) throw new Error("missing flag");

		expect(readStringFlag(["--count=3"], flag, errors)).toBe("3");
		expect(errors).toEqual([]);

		expect(readStringFlag(["--count=0"], flag, errors)).toBeUndefined();
		expect(readStringFlag(["--count=abc"], flag, errors)).toBeUndefined();
		expect(errors).toHaveLength(2);
		expect(errors[0]).toContain("--count expects a positive whole number");
	});
});

describe("formatCommandHelp", () => {
	it("renders every declared flag and example", () => {
		const help = formatCommandHelp(spec);
		expect(help).toContain("Usage: buncargo demo [options]");
		expect(help).toContain("--dry-run");
		expect(help).toContain("--count=N");
		expect(help).toContain("buncargo demo --dry-run");
	});
});
