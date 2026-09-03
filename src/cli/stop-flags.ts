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
	root: {
		name: "--root",
		kind: "string",
		valueHint: "=<path>",
		description: "Checkout whose run to act on (default: this one)",
	},
	all: {
		name: "--all",
		kind: "boolean",
		description: "Stop the whole run: dev servers and containers",
	},
	force: {
		name: "--force",
		kind: "boolean",
		description: "Skip the confirmation for a risky target",
	},
} as const satisfies Record<string, FlagSpec>;

export const STOP_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo stop [<name>...] [options]",
	flags: Object.values(FLAGS),
	notes: [
		{
			command: "<name>",
			description: "App or service from `buncargo runs` (repeatable)",
		},
	],
	examples: [
		{ command: "bunx buncargo stop api", description: "Stop one dev server" },
		{
			command: "bunx buncargo stop postgres",
			description: "Stop one service's container",
		},
		{
			command: "bunx buncargo stop --all",
			description: "Stop this checkout's whole run",
		},
	],
};

export interface StopCliArgs {
	unknownFlags: string[];
	errors: string[];
	help: boolean;
	names: string[];
	root: string | undefined;
	all: boolean;
	force: boolean;
}

export function parseStopArgs(rawArgs: string[]): StopCliArgs {
	const errors: string[] = [];
	const root = readStringFlag(rawArgs, FLAGS.root, errors);
	const all = readBooleanFlag(rawArgs, FLAGS.all);

	// Positionals are whatever is left once flags and their values are gone.
	const names: string[] = [];
	for (let index = 0; index < rawArgs.length; index += 1) {
		const arg = rawArgs[index];
		if (arg === undefined) continue;
		if (arg.startsWith("--")) {
			// `--root <value>` consumes the next argument; `--root=<value>` does not.
			if (arg === FLAGS.root.name) index += 1;
			continue;
		}
		names.push(arg);
	}

	if (names.length === 0 && !all) {
		errors.push(
			"Name at least one app or service, or pass --all to stop the run.",
		);
	}
	if (names.length > 0 && all) {
		errors.push("--all stops everything; do not also name targets.");
	}

	return {
		unknownFlags: findUnknownFlags(STOP_COMMAND_SPEC, rawArgs),
		errors,
		help: readBooleanFlag(rawArgs, FLAGS.help),
		names,
		root,
		all,
		force: readBooleanFlag(rawArgs, FLAGS.force),
	};
}

export function printStopHelp(): void {
	console.log(formatCommandHelp(STOP_COMMAND_SPEC));
}
