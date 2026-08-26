import { describe, expect, it } from "bun:test";
import { formatCommandHelp } from "./command-spec";
import { parseTypecheckArgs, TYPECHECK_COMMAND_SPEC } from "./typecheck-flags";

describe("parseTypecheckArgs", () => {
	it("parses --concurrency=3", () => {
		const args = parseTypecheckArgs(["--concurrency=3"]);
		expect(args.concurrency).toBe(3);
		expect(args.errors).toEqual([]);
		expect(args.unknownFlags).toEqual([]);
	});

	it("rejects 0 and non-integers", () => {
		expect(parseTypecheckArgs(["--concurrency=0"]).errors[0]).toContain(
			"positive whole number",
		);
		expect(parseTypecheckArgs(["--concurrency=nope"]).errors[0]).toContain(
			"positive whole number",
		);
	});

	it("matches --only by a comma-separated list", () => {
		const args = parseTypecheckArgs(["--only=apps/platform,backend"]);
		expect(args.only).toEqual(["apps/platform", "backend"]);
	});

	it("rejects an empty --only", () => {
		expect(parseTypecheckArgs(["--only"]).errors[0]).toContain(
			"--only requires",
		);
		expect(parseTypecheckArgs(["--only="]).errors[0]).toContain(
			"--only requires",
		);
	});

	it("reports unknown flags without throwing", () => {
		expect(parseTypecheckArgs(["--nope"]).unknownFlags).toEqual(["--nope"]);
	});

	it("sets help", () => {
		expect(parseTypecheckArgs(["--help"]).help).toBe(true);
	});
});

describe("TYPECHECK_COMMAND_SPEC help", () => {
	it("renders without needing a config file", () => {
		const help = formatCommandHelp(TYPECHECK_COMMAND_SPEC);
		expect(help).toContain("buncargo typecheck [options]");
		expect(help).toContain("--concurrency=N");
		expect(help).toContain("--only=<workspaces>");
	});
});
