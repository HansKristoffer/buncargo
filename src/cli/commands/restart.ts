import { findMonorepoRoot } from "../../core/ports";
import { DEFAULT_STOP_GRACE_MS } from "../../core/process/terminate";
import { findRunsByRoot } from "../../core/run-registry";
import { defineCommand } from "../command-spec";
import * as log from "../log";
import {
	awaitRestartReply,
	awaitRestartTaken,
	requestRestart,
	withdrawRestartRequest,
} from "../restart-requests";

/** One meaning each, as `stop` and `send` use them. */
export const RESTART_EXIT = {
	ok: 0,
	failed: 1,
	notFound: 2,
	refused: 3,
} as const;

export interface RestartTimeouts {
	/** How long the run has to take the request: it polls twice a second. */
	takenMs: number;
	/** How long it then has to answer, on top of the app's stop grace. */
	answerMs: number;
}

export const RESTART_TIMEOUTS: RestartTimeouts = {
	takenMs: 5_000,
	answerMs: 10_000,
};

/**
 * `buncargo restart <app>`: what `r` does in the TUI, for a run in stream mode
 * (another terminal, a script, an agent). The run itself does the restart, so
 * only it re-reads env and keeps the app's pane and log.
 *
 * Returns once the run answers: the app's process was replaced, so `restart
 * && wait --app` waits for the new one; or why not. A library `start()`
 * takes no requests: exit 3, with the request withdrawn.
 */
export async function restartApps(
	input: {
		root: string;
		session: string | undefined;
		names: readonly string[];
	},
	timeouts: RestartTimeouts,
): Promise<number> {
	const runs = (await findRunsByRoot(input.root)).filter(
		(run) => !input.session || run.sessionId === input.session,
	);
	for (const name of input.names) {
		const run = runs.find((entry) =>
			entry.apps.some((app) => app.name === name && app.pid !== undefined),
		);
		const row = run?.apps.find((app) => app.name === name);
		if (!run || !row) {
			log.error(`No run of ${input.root} started "${name}".`);
			log.hint("`buncargo runs` shows what is active.");
			return RESTART_EXIT.notFound;
		}

		const id = requestRestart(run.root, run.sessionId, name);
		if (!(await awaitRestartTaken(run.root, run.sessionId, timeouts.takenMs))) {
			withdrawRestartRequest(run.root, run.sessionId, id);
			log.error(
				`The run that started ${name} (pid ${run.pid}) takes no restart requests: it is a script's \`start()\`, not \`buncargo dev\`. Nothing was restarted.`,
			);
			log.hint(
				`Restart it from that script, or stop it (\`buncargo stop ${name}\`) and start it with \`buncargo dev\`.`,
			);
			return RESTART_EXIT.refused;
		}
		// The old process gets its stop grace before the new one spawns.
		const answerMs =
			timeouts.answerMs + (row.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
		const reply = await awaitRestartReply(
			run.root,
			run.sessionId,
			id,
			answerMs,
		);
		if (!reply) {
			log.error(
				`The run (pid ${run.pid}) took the request but did not answer within ${Math.round(answerMs / 1000)}s; ${name} may still restart.`,
			);
			log.hint(`Check what it did: buncargo logs ${name} -f`);
			return RESTART_EXIT.failed;
		}
		if (reply.status === "not-ours") {
			log.error(`The run did not restart ${name}: ${reply.reason}.`);
			return RESTART_EXIT.refused;
		}
		if (reply.status === "failed") {
			log.error(`${name} could not be restarted: ${reply.reason}`);
			log.hint(`Its output: buncargo logs ${name}`);
			return RESTART_EXIT.failed;
		}
		log.success(`Restarted ${name}.`);
	}
	return RESTART_EXIT.ok;
}

export const restartCommand = defineCommand({
	spec: {
		name: "restart",
		summary:
			"Restart one app of a running dev (e.g. a stopped non-essential one)",
		flags: {
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
			{
				name: "<app>",
				description: "An app of the run",
				required: true,
				variadic: true,
			},
		],
		examples: [
			{
				command: "bunx buncargo restart shopify",
				description: "Start a stopped app of this checkout's run again",
			},
		],
	},
	exits: {
		[RESTART_EXIT.ok]: "the app's process was replaced",
		[RESTART_EXIT.failed]:
			"the replacement failed, the run did not answer, or bad arguments",
		[RESTART_EXIT.notFound]: "no run of this checkout started the app",
		[RESTART_EXIT.refused]:
			"refused: the run takes no requests (a script's start()) or the app is not its own",
	},
	run: ({ values, positionals }) =>
		restartApps(
			{
				root: values.root ?? findMonorepoRoot(),
				session: values.run,
				names: positionals,
			},
			RESTART_TIMEOUTS,
		),
});
