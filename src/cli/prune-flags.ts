import {
	type CommandSpec,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
} from "./command-spec";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	dryRun: {
		name: "--dry-run",
		kind: "boolean",
		description: "List what would be removed and stop",
	},
	yes: {
		name: "--yes",
		kind: "boolean",
		description: "Skip the confirmation (for scripts)",
	},
} as const satisfies Record<string, FlagSpec>;

export const PRUNE_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo prune [options]",
	flags: Object.values(FLAGS),
	notes: [
		{
			command: "",
			description:
				"Removes volumes whose project has no containers and no run. Destroys their data.",
		},
	],
	examples: [
		{
			command: "bunx buncargo prune --dry-run",
			description: "List reclaimable volumes without touching them",
		},
		{
			command: "bunx buncargo prune",
			description: "Review the list, then confirm removal",
		},
	],
};

export interface PruneCliArgs {
	unknownFlags: string[];
	help: boolean;
	dryRun: boolean;
	yes: boolean;
}

export function parsePruneArgs(rawArgs: string[]): PruneCliArgs {
	return {
		unknownFlags: findUnknownFlags(PRUNE_COMMAND_SPEC, rawArgs),
		help: readBooleanFlag(rawArgs, FLAGS.help),
		dryRun: readBooleanFlag(rawArgs, FLAGS.dryRun),
		yes: readBooleanFlag(rawArgs, FLAGS.yes),
	};
}

export function printPruneHelp(): void {
	console.log(formatCommandHelp(PRUNE_COMMAND_SPEC));
}
