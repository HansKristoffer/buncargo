import {
	type CommandSpec,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readStringFlag,
} from "./command-spec";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	app: {
		name: "--app",
		kind: "string",
		valueHint: "=<name>",
		description: "Use this app's environment and default working directory",
		validate: (value: string) =>
			value ? undefined : "--app requires an app name",
	},
	cwd: {
		name: "--cwd",
		kind: "string",
		valueHint: "=<path>",
		description: "Working directory relative to the repository root",
		validate: (value: string) => (value ? undefined : "--cwd requires a path"),
	},
} as const satisfies Record<string, FlagSpec>;

export const EXEC_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo exec [--app=<name>] [--cwd=<path>] -- <command> [args...]",
	flags: Object.values(FLAGS),
	notes: [
		{
			command: "--",
			description:
				"Required separator; following arguments are passed unchanged",
		},
	],
};

export function parseExecArgs(args: string[]) {
	// Only the prefix belongs to buncargo; child argv is never parsed or rebuilt.
	const separator = args.indexOf("--");
	const optionArgs = separator < 0 ? args : args.slice(0, separator);
	const command = separator < 0 ? [] : args.slice(separator + 1);
	const errors: string[] = [];

	function readOption(flag: FlagSpec) {
		const value = readStringFlag(optionArgs, flag, errors);
		if (readBooleanFlag(optionArgs, flag) && value === undefined) {
			errors.push(`${flag.name} requires a value`);
		}
		return value;
	}

	const app = readOption(FLAGS.app);
	const cwd = readOption(FLAGS.cwd);
	const help = readBooleanFlag(optionArgs, FLAGS.help);

	// Skip each option's value when looking for stray positional arguments.
	for (let i = 0; i < optionArgs.length; i++) {
		const token = optionArgs[i] ?? "";
		const flag = EXEC_COMMAND_SPEC.flags.find(
			(flag) => token === flag.name || token.startsWith(`${flag.name}=`),
		);
		if (!flag) {
			if (!token.startsWith("--")) {
				errors.push(`Unexpected argument before --: ${token}`);
			}
			continue;
		}

		if (flag.kind === "string" && token === flag.name) {
			i++;
		}
	}

	if (!help && command.length === 0) {
		errors.push("Provide a command after --");
	}

	return {
		app,
		cwd,
		help,
		command,
		errors: [
			...errors,
			...findUnknownFlags(EXEC_COMMAND_SPEC, optionArgs).map(
				(flag) => `Unknown flag: ${flag}`,
			),
		],
	};
}

export const printExecHelp = () =>
	console.log(formatCommandHelp(EXEC_COMMAND_SPEC));
