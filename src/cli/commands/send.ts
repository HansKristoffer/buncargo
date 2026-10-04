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
import { requestSend } from "../restart-requests";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	enter: {
		name: "--enter",
		kind: "boolean",
		description: "Press Enter after the text",
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

export const SEND_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo send <app> <keys> [options]",
	flags: Object.values(FLAGS),
	examples: [
		{
			command: "bunx buncargo send expoApp i",
			description: "Press i in Expo: open the iOS simulator",
		},
		{
			command: "bunx buncargo send api rs --enter",
			description: "Type a line into an app's prompt",
		},
	],
};

/**
 * `buncargo send <app> <keys>`: type into an app of a running `dev` that has
 * a terminal of its own (every app in the TUI, and an interactive app such as
 * Expo when the run has no terminal). The keys an agent could not press.
 */
export async function handleSend(args: string[]): Promise<number> {
	if (readBooleanFlag(args, FLAGS.help)) {
		console.log(formatCommandHelp(SEND_COMMAND_SPEC));
		return 0;
	}
	const errors: string[] = [];
	const root = readStringFlag(args, FLAGS.root, errors) ?? findMonorepoRoot();
	const session = readStringFlag(args, FLAGS.run, errors);
	const [name, ...words] = readPositionals(SEND_COMMAND_SPEC, args);
	errors.push(
		...findUnknownFlags(SEND_COMMAND_SPEC, args).map(
			(flag) => `Unknown flag: ${flag}`,
		),
	);
	const enter = readBooleanFlag(args, FLAGS.enter);
	if (!name) errors.push("Name the app to type into.");
	if (words.length === 0 && !enter) errors.push("Give the keys to send.");
	if (errors.length > 0 || !name) throw argumentsError(errors, "send");

	const run = (await findRunsByRoot(root)).find(
		(entry) =>
			(!session || entry.sessionId === session) &&
			entry.apps.some((app) => app.name === name && app.pid !== undefined),
	);
	if (!run)
		throw new CliError(`No run of ${root} started "${name}".`, [
			"`buncargo runs` shows what is active.",
		]);
	requestSend(
		run.root,
		run.sessionId,
		name,
		`${words.join(" ")}${enter ? "\r" : ""}`,
	);
	log.success(`Sent to ${name}. Its output: buncargo logs ${name} -f`);
	return 0;
}
