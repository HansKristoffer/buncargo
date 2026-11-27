import { typedSwitch } from "hanzio";
import { findMonorepoRoot } from "../../core/ports";
import { DEFAULT_STOP_GRACE_MS } from "../../core/process/terminate";
import { findRunsByRoot, type RunEntry } from "../../core/run-registry";
import { defineCommand } from "../command-spec";
import { runsThatCanStart } from "../dev-late-start";
import type { RestartJson, RestartResultJson } from "../json-documents";
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
	/** How long the run has to take the request (watched via `fs.watch`). */
	takenMs: number;
	/** How long it then has to answer, on top of the app's stop grace. */
	answerMs: number;
}

export const RESTART_TIMEOUTS: RestartTimeouts = {
	takenMs: 5_000,
	answerMs: 10_000,
};

/** The exit code of each outcome. */
const OUTCOME_EXIT: Record<RestartResultJson["outcome"], number> = {
	restarted: RESTART_EXIT.ok,
	started: RESTART_EXIT.ok,
	failed: RESTART_EXIT.failed,
	"not-found": RESTART_EXIT.notFound,
	refused: RESTART_EXIT.refused,
};

/**
 * `buncargo restart <app>`: what `r` does in the TUI, for a run in stream mode
 * (another terminal, a script, an agent). The run itself does the restart, so
 * only it re-reads env and keeps the app's pane and log. An app the run left
 * out (not in its `--apps` or profile) is started in it instead.
 *
 * Returns once the run answers: the app's process was replaced, or its start
 * began, so `restart && wait --app` waits for the new one; or why not. A
 * library `start()` takes no requests: exit 3, with the request withdrawn.
 * Stops at the first app that did not restart; `json` prints every answer
 * so far as one {@link RestartJson} instead of lines.
 */
export async function restartApps(
	input: {
		root: string;
		session: string | undefined;
		names: readonly string[];
		json: boolean;
	},
	timeouts: RestartTimeouts,
): Promise<number> {
	const runs = (await findRunsByRoot(input.root)).filter(
		(run) => !input.session || run.sessionId === input.session,
	);

	const results: RestartResultJson[] = [];
	let exitCode: number = RESTART_EXIT.ok;
	for (const name of input.names) {
		const result = await restartApp(runs, input.root, name, timeouts);
		results.push(result);
		if (!input.json) printResult(result);

		exitCode = OUTCOME_EXIT[result.outcome];
		if (exitCode !== RESTART_EXIT.ok) break;
	}

	if (input.json) {
		const document: RestartJson = { version: 1, exitCode, results };
		log.line(JSON.stringify(document, null, 2));
	}
	return exitCode;
}

function printResult(result: RestartResultJson): void {
	if (OUTCOME_EXIT[result.outcome] === RESTART_EXIT.ok) {
		log.success(result.message);
	} else {
		log.error(result.message);
	}
	for (const hint of result.hints) log.hint(hint);
}

async function restartApp(
	runs: readonly RunEntry[],
	root: string,
	name: string,
	timeouts: RestartTimeouts,
): Promise<RestartResultJson> {
	const result = (
		outcome: RestartResultJson["outcome"],
		message: string,
		hints: string[] = [],
	): RestartResultJson => ({ app: name, outcome, message, hints });

	const running = runs.find((entry) =>
		entry.apps.some((app) => app.name === name && app.pid !== undefined),
	);
	const row = running?.apps.find((app) => app.name === name);
	const starting = running === undefined;

	// Not running: the run listing it has begun its start; otherwise the
	// run that spawned apps can start it, if only one did.
	const listing = runs.find((entry) =>
		entry.apps.some((app) => app.name === name),
	);
	const spawning = runsThatCanStart(runs);
	if (!running && !listing && spawning.length > 1) {
		return result(
			"failed",
			`${name} is not running, and ${spawning.length} runs of ${root} could start it.`,
			["Pass --run=<session> (from `buncargo runs`)."],
		);
	}

	const run = running ?? listing ?? spawning[0];
	if (!run) {
		return result("not-found", `No run of ${root} started "${name}".`, [
			"`buncargo runs` shows what is active.",
		]);
	}

	const id = requestRestart(run.root, run.sessionId, name);
	const taken = await awaitRestartTaken(
		run.root,
		run.sessionId,
		timeouts.takenMs,
	);
	if (!taken) {
		withdrawRestartRequest(run.root, run.sessionId, id);
		const which = starting ? "The run" : `The run that started ${name}`;
		const done = starting ? "started" : "restarted";
		return result(
			"refused",
			`${which} (pid ${run.pid}) takes no restart requests: it is a script's \`start()\`, not \`buncargo dev\`. Nothing was ${done}.`,
			[
				`Restart it from that script, or stop it (\`buncargo stop ${name}\`) and start it with \`buncargo dev\`.`,
			],
		);
	}

	// The old process gets its stop grace before the new one spawns.
	const answerMs =
		timeouts.answerMs + (row?.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
	const reply = await awaitRestartReply(run.root, run.sessionId, id, answerMs);

	if (!reply) {
		const waitedSeconds = Math.round(answerMs / 1000);
		return result(
			"failed",
			`The run (pid ${run.pid}) took the request but did not answer within ${waitedSeconds}s; ${name} may still restart.`,
			[`Check what it did: buncargo logs ${name} -f`],
		);
	}

	return typedSwitch(reply, "status", {
		began: () => result("restarted", `Restarted ${name}.`),
		started: ({ apps }) => {
			const what =
				apps.length === 0
					? `${name} is already starting`
					: `Started ${apps.join(", ")}`;
			return {
				...result("started", `${what} in the run (pid ${run.pid}).`),
				apps: [...apps],
			};
		},
		refused: ({ reason }) => {
			const [first, ...rest] = reason.split("\n");
			return result("refused", `The run did not start ${name}: ${first}`, rest);
		},
		failed: ({ reason }) =>
			result("failed", `${name} could not be restarted: ${reason}`, [
				`Its output: buncargo logs ${name}`,
			]),
		"not-ours": ({ reason }) => {
			if (starting) {
				return result(
					"not-found",
					`No run of ${root} started "${name}": ${reason}.`,
					["`buncargo runs` shows what is active."],
				);
			}
			return result("refused", `The run did not restart ${name}: ${reason}.`);
		},
	});
}

export const restartCommand = defineCommand({
	spec: {
		name: "restart",
		summary: "Restart one app of a running dev, or start one it left out",
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
			json: { kind: "boolean", description: "One JSON document on stdout" },
		},
		args: [
			{
				name: "<app>",
				description: "An app of the run, or one it left out",
				required: true,
				variadic: true,
			},
		],
		examples: [
			{
				command: "bunx buncargo restart shopify",
				description: "Start a stopped app of this checkout's run again",
			},
			{
				command: "bunx buncargo restart mobile",
				description:
					"Start an app the run left out (not in its --apps or profile)",
			},
		],
	},
	exits: {
		[RESTART_EXIT.ok]:
			"the app's process was replaced, or the start of a left-out app began",
		[RESTART_EXIT.failed]:
			"the replacement failed, the run did not answer or is still starting its own apps, several runs could start a left-out app, or bad arguments",
		[RESTART_EXIT.notFound]:
			"no run of this checkout started the app or can start it",
		[RESTART_EXIT.refused]:
			"refused: the run takes no requests (a script's start()), the app is not its own, or a left-out app needs a service the run did not start, a lease another run holds or a terminal for its preflight",
	},
	json: "RestartJson (--json)",
	run: ({ values, positionals }) =>
		restartApps(
			{
				root: values.root ?? findMonorepoRoot(),
				session: values.run,
				names: positionals,
				json: values.json,
			},
			RESTART_TIMEOUTS,
		),
});
