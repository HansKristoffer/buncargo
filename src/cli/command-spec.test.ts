import { describe, expect, it, spyOn } from "bun:test";
import {
	BASE_EXITS,
	type CommandSpec,
	defineCommand,
	defineGroup,
	formatExitCodeTable,
	parseArgs,
	positiveIntegerValidator,
	runCommand,
} from "./command-spec";
import { ArgumentsError } from "./errors";

const SPEC = {
	name: "demo",
	summary: "A demo",
	flags: {
		"dry-run": { kind: "boolean", description: "Do nothing" },
		count: {
			kind: "string",
			value: "N",
			description: "How many",
			validate: positiveIntegerValidator("--count"),
		},
		expose: { kind: "optional", value: "<targets>", description: "Share" },
		follow: { kind: "boolean", short: "f", description: "Keep going" },
	},
	args: [{ name: "<app>", description: "Apps", variadic: true }],
	passthrough: "For the app",
} as const satisfies CommandSpec;

function parsed(argv: string[]) {
	const result = parseArgs(SPEC, argv);
	if (result.help) throw new Error("help");
	return result;
}

/** Every problem `parseArgs` reports for `argv`, message and hints. */
function problems(spec: CommandSpec, argv: string[]): string[] {
	try {
		parseArgs(spec, argv);
	} catch (error) {
		if (!(error instanceof ArgumentsError)) throw error;
		return [error.message, ...error.hints.slice(0, -1)];
	}
	throw new Error(`${argv.join(" ")} parsed`);
}

describe("parseArgs", () => {
	it("reads each kind of flag in every form it takes, and keeps the rest", () => {
		const result = parsed([
			"api",
			"--count",
			"3",
			"--expose",
			"web",
			"-f",
			"--",
			"--clear",
		]);
		expect(result.values).toEqual({
			"dry-run": false,
			count: "3",
			expose: true,
			follow: true,
		});
		// An optional value is only ever inline: `--expose web` exposes all.
		expect(result.positionals).toEqual(["api", "web"]);
		expect(result.passthrough).toEqual(["--clear"]);
		expect(parsed(["--count=4", "--expose=api,web"]).values).toMatchObject({
			count: "4",
			expose: "api,web",
		});
	});

	// `dev --profile` ran the default profile, and `--profile --apps=x` read
	// the next flag as the profile's name.
	it("rejects a string flag without its value", () => {
		for (const argv of [["--count"], ["--count="], ["--count", "--dry-run"]])
			expect(problems(SPEC, argv)).toEqual([
				"--count requires a value: --count=N.",
			]);
	});

	// `status --jsno` printed prose and exited 0; `dev --detach=1` read as
	// --detach, stayed in the background run's argv and detached forever.
	it("reports every problem at once: unknown flags, values on booleans, bad and repeated values, extra arguments", () => {
		expect(
			problems(SPEC, [
				"--jsno",
				"--dry-run=1",
				"--count=0",
				"--count=2",
				"--count=3",
			]),
		).toEqual([
			"Unknown flag: --jsno",
			"--dry-run takes no value: pass --dry-run, not --dry-run=1.",
			'--count expects a positive whole number, got "0".',
			"--count is given twice.",
		]);
		const fixed = {
			name: "fixed",
			summary: "",
			flags: {},
			args: [{ name: "<offset>", description: "", required: true }],
		} as const satisfies CommandSpec;
		expect(problems(fixed, [])).toEqual(["Missing <offset>."]);
		expect(problems(fixed, ["1", "2", "--", "x"])).toEqual([
			"Unexpected argument: 2",
			"fixed takes no arguments after --: x",
		]);
	});

	// `doctor --help` ran the sweep and `dev -h` started the environment.
	it("answers --help and -h before anything else", () => {
		expect(parseArgs(SPEC, ["--nope", "-h"])).toEqual({ help: true });
		expect(parseArgs(SPEC, ["--count", "--help"])).toEqual({ help: true });
	});

	it("hands undeclared flags and positionals on in order when the spec forwards them", () => {
		const prisma = {
			name: "prisma",
			summary: "",
			flags: { yes: { kind: "boolean", description: "" } },
			forwardUnknown: true,
		} as const satisfies CommandSpec;
		const result = parseArgs(prisma, [
			"migrate",
			"dev",
			"--name",
			"init",
			"--yes",
			"-abc",
			"--help",
			"--",
			"--x",
		]);
		expect(result).toEqual({
			help: false,
			values: { yes: true },
			positionals: [
				"migrate",
				"dev",
				"--name",
				"init",
				"-abc",
				"--help",
				"--",
				"--x",
			],
			passthrough: [],
		});
		expect(parseArgs(prisma, ["--help"])).toEqual({ help: true });
	});
});

describe("runCommand", () => {
	const ran: string[][] = [];
	const leaf = (name: string) =>
		defineCommand({
			spec: {
				name,
				summary: `${name} summary`,
				flags: {},
				args: [{ name: "<x>", description: "", variadic: true }],
			},
			exits: BASE_EXITS,
			run: ({ positionals }) => {
				ran.push([name, ...positionals]);
				return 0;
			},
		});
	const group = defineGroup({
		spec: { name: "tool", summary: "A tool" },
		subcommands: { install: leaf("tool install") },
		fallback: leaf("tool status"),
	});

	async function quietly(argv: string[]) {
		const error = spyOn(console, "error").mockImplementation(() => {});
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			return await runCommand(group, argv);
		} finally {
			error.mockRestore();
			log.mockRestore();
		}
	}

	it("runs a named subcommand, the fallback without one, and exits 1 on an unknown one", async () => {
		ran.length = 0;
		expect(await quietly(["install", "a"])).toBe(0);
		expect(await quietly([])).toBe(0);
		expect(await quietly(["nope"])).toBe(1);
		expect(ran).toEqual([["tool install", "a"], ["tool status"]]);
	});
});

describe("formatExitCodeTable", () => {
	it("lists each command's codes beyond 0 and 1, a group's subcommands by their own names", () => {
		const table = formatExitCodeTable([
			defineGroup({
				spec: { name: "kit", summary: "" },
				subcommands: {
					stop: defineCommand({
						spec: { name: "kit stop", summary: "", flags: {} },
						exits: { ...BASE_EXITS, 3: "refused" },
						json: "KitJson",
						run: () => 0,
					}),
				},
			}),
		]);
		expect(table).toContain("kit stop  3  refused");
		expect(table).toContain("kit stop  KitJson");
		expect(table).not.toContain("kit stop  1");
	});
});
