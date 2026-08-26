import {
	type CommandSpec,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	positiveIntegerValidator,
	readBooleanFlag,
	readStringFlag,
} from "./command-spec";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	concurrency: {
		name: "--concurrency",
		kind: "string",
		valueHint: "=N",
		description:
			"Max typecheck processes (default: CPUs, cap 4 local / 2 in CI)",
		validate: positiveIntegerValidator("--concurrency"),
	},
	only: {
		name: "--only",
		kind: "string",
		valueHint: "=<workspaces>",
		description:
			"Check only these workspaces (path or basename, comma-separated)",
	},
} as const satisfies Record<string, FlagSpec>;

export const TYPECHECK_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo typecheck [options]",
	flags: Object.values(FLAGS),
	examples: [
		{
			command: "bunx buncargo typecheck",
			description: "Check every workspace plus the root config",
		},
		{
			command: "bunx buncargo typecheck --only=platform",
			description: "Check one workspace (path or basename)",
		},
		{
			command: "bunx buncargo typecheck --concurrency=2",
			description: "Cap overlapping typecheck processes",
		},
	],
};

export interface TypecheckCliArgs {
	unknownFlags: string[];
	errors: string[];
	help: boolean;
	concurrency: number | undefined;
	only: string[] | undefined;
}

export function parseTypecheckArgs(rawArgs: string[]): TypecheckCliArgs {
	const errors: string[] = [];
	const concurrencyValue = readStringFlag(rawArgs, FLAGS.concurrency, errors);
	const onlyValue = readStringFlag(rawArgs, FLAGS.only, errors);

	let only: string[] | undefined;
	if (readBooleanFlag(rawArgs, FLAGS.only)) {
		only = (onlyValue ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean);
		if (only.length === 0) {
			errors.push("--only requires at least one workspace name.");
		}
	}

	return {
		unknownFlags: findUnknownFlags(TYPECHECK_COMMAND_SPEC, rawArgs),
		errors,
		help: readBooleanFlag(rawArgs, FLAGS.help),
		concurrency:
			concurrencyValue === undefined
				? undefined
				: Number.parseInt(concurrencyValue, 10),
		only,
	};
}

export function printTypecheckHelp(): void {
	console.log(formatCommandHelp(TYPECHECK_COMMAND_SPEC));
}
