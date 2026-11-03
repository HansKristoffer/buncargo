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
	run: {
		name: "--run",
		kind: "string",
		valueHint: "=<session>",
		description:
			"One run session from buncargo runs (default: matching checkout sessions)",
	},
	all: {
		name: "--all",
		kind: "boolean",
		description:
			"Stop the whole run: dev servers and containers, and an ended run's idle containers",
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
		{
			command: "bunx buncargo stop",
			description:
				"Same as --all: stop this checkout's run (one in another terminal asks first)",
		},
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
	run: string | undefined;
	/** `--all`, or no target named: the whole run. */
	all: boolean;
	force: boolean;
}

export function parseStopArgs(rawArgs: string[]): StopCliArgs {
	const errors: string[] = [];
	const root = readStringFlag(rawArgs, FLAGS.root, errors);
	const run = readStringFlag(rawArgs, FLAGS.run, errors);
	const all = readBooleanFlag(rawArgs, FLAGS.all);

	// Positionals are whatever is left once flags and their values are gone.
	const names: string[] = [];
	for (let index = 0; index < rawArgs.length; index += 1) {
		const arg = rawArgs[index];
		if (arg === undefined) continue;
		if (arg.startsWith("--")) {
			// `--root <value>` consumes the next argument; `--root=<value>` does not.
			if (arg === FLAGS.root.name || arg === FLAGS.run.name) index += 1;
			continue;
		}
		names.push(arg);
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
		run,
		// Agents and project docs say `buncargo stop` meaning "stop my run":
		// that is what a bare stop does. A run in another terminal still asks
		// (or, without a terminal, refuses and names --force), as --all does.
		all: all || names.length === 0,
		force: readBooleanFlag(rawArgs, FLAGS.force),
	};
}

export function printStopHelp(): void {
	console.log(formatCommandHelp(STOP_COMMAND_SPEC));
}
