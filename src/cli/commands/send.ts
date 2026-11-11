import { findMonorepoRoot } from "../../core/ports";
import { findRunsByRoot } from "../../core/run-registry";
import { defineCommand } from "../command-spec";
import { argumentsError, CliError } from "../errors";
import * as log from "../log";
import { awaitSendReply, requestSend } from "../restart-requests";

/** `stop`'s codes: 0 typed · 2 no run started the app · 3 it cannot take keys. */
export const SEND_EXIT = { ok: 0, notFound: 2, refused: 3 } as const;

/** The run polls for requests every 500ms; a run that is up answers well within this. */
const REPLY_TIMEOUT_MS = 5_000;

/**
 * `buncargo send <app> <keys>`: type into an app of a running `dev` that has
 * a terminal of its own (every app in the TUI, and an interactive app such as
 * Expo when the run has no terminal). The keys an agent could not press.
 *
 * It waits for the run's answer: keys that reached no app are a failure the
 * caller has to see, not a warning in a run it is not watching.
 */
async function sendKeys(input: {
	root: string;
	session: string | undefined;
	name: string;
	words: readonly string[];
	enter: boolean;
}): Promise<number> {
	const { root, session, name, words, enter } = input;
	if (words.length === 0 && !enter)
		throw argumentsError(["Give the keys to send."], "send");

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
		REPLY_TIMEOUT_MS,
	);
	if (!reply)
		throw new CliError(
			`The run (pid ${run.pid}) did not answer within ${Math.round(REPLY_TIMEOUT_MS / 1000)}s; the keys may still arrive.`,
			[`Check what ${name} did: buncargo logs ${name} -f`],
		);
	if (!reply.delivered) {
		log.error(`Cannot send to ${name}: ${reply.reason}.`);
		return SEND_EXIT.refused;
	}
	log.success(`Sent to ${name}. Its output: buncargo logs ${name} -f`);
	return SEND_EXIT.ok;
}

export const sendCommand = defineCommand({
	spec: {
		name: "send",
		summary: "Type into an app that has a terminal (e.g. Expo's i)",
		flags: {
			enter: { kind: "boolean", description: "Press Enter after the text" },
			root: {
				kind: "string",
				value: "<path>",
				description: "Checkout whose run to act on (default: this one)",
			},
			run: {
				kind: "string",
				value: "<session>",
				description: "One run session from buncargo runs",
			},
		},
		args: [
			{ name: "<app>", description: "An app of the run", required: true },
			{
				name: "<keys>",
				description: "The text to type, words joined by spaces",
				variadic: true,
			},
		],
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
	},
	exits: {
		[SEND_EXIT.ok]: "typed",
		1: "the run did not answer, or bad arguments",
		[SEND_EXIT.notFound]: "no run of this checkout started the app",
		[SEND_EXIT.refused]:
			"the app cannot take keys (no terminal of its own, or not running)",
	},
	run: ({ values, positionals: [name, ...words] }) =>
		sendKeys({
			root: values.root ?? findMonorepoRoot(),
			session: values.run,
			name,
			words,
			enter: values.enter,
		}),
});
