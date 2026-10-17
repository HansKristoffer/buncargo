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
import { awaitSendReply, requestSend } from "../restart-requests";

/** `stop`'s codes: 0 typed · 2 no run started the app · 3 it cannot take keys. */
export const SEND_EXIT = { ok: 0, notFound: 2, refused: 3 } as const;

/** The run polls for requests every 500ms; a run that is up answers well within this. */
const REPLY_TIMEOUT_MS = 5_000;

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
 *
 * It waits for the run's answer: keys that reached no app are a failure the
 * caller has to see, not a warning in a run it is not watching.
 */
export async function handleSend(
	args: string[],
	options: { replyTimeoutMs?: number } = {},
): Promise<number> {
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
	if (!run) {
		log.error(`No run of ${root} started "${name}".`);
		log.hint("`buncargo runs` shows what is active.");
		return SEND_EXIT.notFound;
	}
	const status = run.apps.find((app) => app.name === name)?.status;
	if (status === "stopped" || status === "failed") {
		log.error(`Cannot send to ${name}: it is not running (${status}).`);
		log.hint(`Start it again: buncargo restart ${name}`);
		return SEND_EXIT.refused;
	}

	const id = requestSend(
		run.root,
		run.sessionId,
		name,
		`${words.join(" ")}${enter ? "\r" : ""}`,
	);
	const reply = await awaitSendReply(
		run.root,
		run.sessionId,
		id,
		options.replyTimeoutMs ?? REPLY_TIMEOUT_MS,
	);
	if (!reply)
		throw new CliError(
			`The run (pid ${run.pid}) did not answer within ${Math.round((options.replyTimeoutMs ?? REPLY_TIMEOUT_MS) / 1000)}s; the keys may still arrive.`,
			[`Check what ${name} did: buncargo logs ${name} -f`],
		);
	if (!reply.delivered) {
		log.error(`Cannot send to ${name}: ${reply.reason}.`);
		return SEND_EXIT.refused;
	}
	log.success(`Sent to ${name}. Its output: buncargo logs ${name} -f`);
	return SEND_EXIT.ok;
}
