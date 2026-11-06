import { promiseTimeout } from "hanzio";
import { findMonorepoRoot } from "../../core/ports";
import {
	findRunsByRoot,
	loadRuns,
	type RunAppEntry,
} from "../../core/run-registry";
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
import {
	awaitRestartTaken,
	requestRestart,
	withdrawRestartRequest,
} from "../restart-requests";

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

export const RESTART_EXIT = { ok: 0, refused: 3 } as const;

export interface RestartTimeouts {
	/** How long the run has to take the request: it polls twice a second. */
	takenMs: number;
	/** How long it then has to show the restart on the app's row. */
	beganMs: number;
}

export const RESTART_TIMEOUTS: RestartTimeouts = {
	takenMs: 5_000,
	beganMs: 10_000,
};

/**
 * Whether an app's row shows the restart the run took: a new process, or
 * another state (`starting` from the run's own mark, `failed` when it could
 * not be replaced). The command never writes the row itself: only the run
 * knows the restart began, and a row it marked for a run that never restarts
 * stayed `starting`, hanging `restart && wait`.
 */
export function restartBegan(
	before: RunAppEntry,
	after: RunAppEntry | undefined,
): boolean {
	if (after === undefined) return true;
	return after.pid !== before.pid || after.status !== before.status;
}

/**
 * `buncargo restart <app>`: what `r` does in the TUI, for a run in stream mode
 * (another terminal, a script, an agent). The run itself does the restart, so
 * only it re-reads env and keeps the app's pane and log.
 *
 * Returns once the app's row shows the restart, so `restart && wait --app`
 * waits for the new process. A library `start()` takes no requests: exit 3,
 * with the request withdrawn.
 */
export async function handleRestart(
	args: string[],
	timeouts: RestartTimeouts,
): Promise<number> {
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
		const row = run?.apps.find((app) => app.name === name);
		if (!run || !row)
			throw new CliError(`No run of ${root} started "${name}".`, [
				"`buncargo runs` shows what is active.",
			]);

		requestRestart(run.root, run.sessionId, name);
		if (!(await awaitRestartTaken(run.root, run.sessionId, timeouts.takenMs))) {
			withdrawRestartRequest(run.root, run.sessionId, name);
			log.error(
				`The run that started ${name} (pid ${run.pid}) takes no restart requests: it is a script's \`start()\`, not \`buncargo dev\`. Nothing was restarted.`,
			);
			log.hint(
				`Restart it from that script, or stop it (\`buncargo stop ${name}\`) and start it with \`buncargo dev\`.`,
			);
			return RESTART_EXIT.refused;
		}
		if (await awaitRestartBegan(run.sessionId, row, timeouts.beganMs))
			log.success(`Restarting ${name}.`);
		else
			log.warn(
				`The run took the request but has not begun restarting ${name} yet: \`buncargo logs ${name} -f\` shows what it does.`,
			);
	}
	return RESTART_EXIT.ok;
}

/** Read the registry, without liveness, until the app's row moves on. */
async function awaitRestartBegan(
	sessionId: string,
	before: RunAppEntry,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const entry = (await loadRuns()).find((run) => run.sessionId === sessionId);
		const after = entry?.apps.find((app) => app.name === before.name);
		if (restartBegan(before, after)) return true;
		if (Date.now() >= deadline) return false;
		await promiseTimeout(50);
	}
}
