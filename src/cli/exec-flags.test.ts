import { expect, it } from "bun:test";
import { parseExecArgs } from "./exec-flags";

it("parses only options before -- and preserves child argv", () => {
	const command = [
		"bun",
		"file name.ts",
		"a'b",
		'a"b',
		"$HOME",
		"$(touch bad)",
		";",
		"--app=child",
	];
	expect(
		parseExecArgs(["--app=api", "--cwd", "packages/prisma", "--", ...command]),
	).toMatchObject({ app: "api", cwd: "packages/prisma", command, errors: [] });
});

it("rejects missing commands, empty options, unknown options and stray positionals", () => {
	for (const args of [
		[],
		["--app=", "--", "bun"],
		["--bad", "--", "bun"],
		["stray", "--", "bun"],
	])
		expect(parseExecArgs(args).errors.length).toBeGreaterThan(0);
	expect(parseExecArgs(["--help"]).errors).toEqual([]);
});
