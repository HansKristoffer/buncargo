import { findMonorepoRoot } from "../../core/ports";
import { findRunsByRoot } from "../../core/run-registry";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
	readStringFlag,
} from "../command-spec";
import { argumentsError, CliError } from "../errors";
import * as log from "../log";
import { requestRestart } from "../restart-requests";

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
		description: "One run session from buncargo runs",
	},
} as const;

export const RESTART_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo restart <app> [options]",
	flags: Object.values(FLAGS),
	examples: [
		{
			command: "bunx buncargo restart shopify",
			description: "Start a stopped app of this checkout's run again",
		},
	],
};

/**
 * `buncargo restart <app>`: what `r` does in the TUI, for a run in stream mode
 * (another terminal, a script, an agent). The run itself does the restart, so
 * only it re-reads env and keeps the app's pane and log.
 */
export async function handleRestart(args: string[]): Promise<number> {
	if (readBooleanFlag(args, FLAGS.help)) {
		console.log(formatCommandHelp(RESTART_COMMAND_SPEC));
		return 0;
	}
	const errors: string[] = [];
	const root = readStringFlag(args, FLAGS.root, errors) ?? findMonorepoRoot();
	const session = readStringFlag(args, FLAGS.run, errors);
	const names = readPositionals(RESTART_COMMAND_SPEC, args);
	errors.push(
		...findUnknownFlags(RESTART_COMMAND_SPEC, args).map(
			(flag) => `Unknown flag: ${flag}`,
		),
	);
	if (names.length === 0) errors.push("Name the app to restart.");
	if (errors.length > 0) throw argumentsError(errors, "restart");

	const runs = (await findRunsByRoot(root)).filter(
		(run) => !session || run.sessionId === session,
	);
	for (const name of names) {
		const run = runs.find((entry) =>
			entry.apps.some((app) => app.name === name && app.pid !== undefined),
		);
		if (!run)
			throw new CliError(`No run of ${root} started "${name}".`, [
				"`buncargo runs` shows what is active.",
			]);
		requestRestart(run.root, run.sessionId, name);
		log.success(`Asked the run to restart ${name}.`);
	}
	return 0;
}
