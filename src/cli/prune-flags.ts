import {
	type CommandSpec,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readStringFlag,
} from "./command-spec";

/** `7d`, `12h`, `30m` in milliseconds, or undefined when it is none of them. */
export function parseAge(value: string): number | undefined {
	const match = /^(\d+)(m|h|d)$/.exec(value.trim());
	if (!match) return undefined;
	const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[
		match[2] as "m" | "h" | "d"
	];
	const ms = Number(match[1]) * unit;
	return ms > 0 ? ms : undefined;
}

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
	olderThan: {
		name: "--older-than",
		kind: "string",
		valueHint: "=<age>",
		description:
			"Only volumes of checkouts deleted at least this long ago, e.g. 7d, 12h, 30m",
		validate: (value) =>
			parseAge(value) === undefined
				? `--older-than expects an age such as 7d, 12h or 30m, got "${value}".`
				: undefined,
	},
	project: {
		name: "--project",
		kind: "boolean",
		description:
			"Only this project's leftovers: every checkout's ci stack and every stack of a deleted worktree (containers, volumes, networks)",
	},
} as const satisfies Record<string, FlagSpec>;

export const PRUNE_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo prune [options]",
	flags: Object.values(FLAGS),
	notes: [
		{
			command: "",
			description:
				"Removes the volumes of checkouts whose directory was deleted, when no container, run or other checkout uses their project. Destroys their data.",
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
		{
			command: "bunx buncargo prune --older-than=7d --dry-run",
			description: "Only checkouts deleted a week ago or longer",
		},
		{
			command: "bunx buncargo prune --project --dry-run",
			description:
				"List this project's leftover ci and deleted-worktree stacks",
		},
	],
};

export interface PruneCliArgs {
	unknownFlags: string[];
	help: boolean;
	dryRun: boolean;
	yes: boolean;
	/** `--older-than` in milliseconds. */
	olderThanMs?: number;
	project: boolean;
	/** Values that did not parse, each a sentence. */
	errors: string[];
}

export function parsePruneArgs(rawArgs: string[]): PruneCliArgs {
	const errors: string[] = [];
	const olderThan = readStringFlag(rawArgs, FLAGS.olderThan, errors);
	return {
		unknownFlags: findUnknownFlags(PRUNE_COMMAND_SPEC, rawArgs),
		help: readBooleanFlag(rawArgs, FLAGS.help),
		dryRun: readBooleanFlag(rawArgs, FLAGS.dryRun),
		yes: readBooleanFlag(rawArgs, FLAGS.yes),
		olderThanMs: olderThan === undefined ? undefined : parseAge(olderThan),
		project: readBooleanFlag(rawArgs, FLAGS.project),
		errors,
	};
}

export function printPruneHelp(): void {
	console.log(formatCommandHelp(PRUNE_COMMAND_SPEC));
}
