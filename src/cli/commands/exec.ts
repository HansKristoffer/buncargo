import {
	formatCheckSlotWait,
	processCheckSlot,
	withCheckSlot,
} from "../../core/check-slots";
import { CommandSignalError, type ExecResult } from "../../core/process";
import { loadDevEnv } from "../../loader";
import { BASE_EXITS, defineCommand } from "../command-spec";
import { argumentsError } from "../errors";
import { databaseExists, databaseOverrides } from "./exec-database";

/**
 * Run a foreground command, forwarding SIGINT/SIGTERM/SIGHUP to it.
 *
 * Forwards the actual signal, but keeps shell exit semantics (130/143/129)
 * even if the child's signal handler exits successfully after its own cleanup.
 */
export async function runForwardingSignals(
	run: (signal: AbortSignal) => Promise<ExecResult>,
): Promise<number> {
	const controller = new AbortController();
	let interrupted: number | undefined;

	const listeners = Object.entries({
		SIGINT: 130,
		SIGTERM: 143,
		SIGHUP: 129,
	}).map(([signal, code]) => {
		const listener = () => {
			interrupted = code;
			controller.abort(new CommandSignalError(signal as NodeJS.Signals));
		};
		process.on(signal, listener);
		return { signal, listener };
	});

	try {
		const result = await run(controller.signal);
		return interrupted ?? result.exitCode;
	} finally {
		for (const { signal, listener } of listeners) {
			process.off(signal, listener);
		}
	}
}

/**
 * A shell command with extra arguments appended, as argv.
 *
 * Handing the arguments to `sh` as positional parameters means none of them is
 * ever re-parsed by the shell, so nothing has to be quoted.
 */
export function withAppendedArgs(
	command: string,
	args: readonly string[],
): string | string[] {
	return args.length === 0
		? command
		: ["sh", "-c", `${command} "$@"`, "sh", ...args];
}

export const execCommand = defineCommand({
	spec: {
		name: "exec",
		usage: "exec [options] -- <command> [args...]",
		summary: "Run a command with the checkout environment",
		flags: {
			app: {
				kind: "string",
				value: "<name>",
				description: "Use this app's environment and default working directory",
			},
			cwd: {
				kind: "string",
				value: "<path>",
				description: "Working directory relative to the repository root",
			},
			db: {
				kind: "string",
				value: "<name>",
				description:
					"Point the variables that name this checkout's Postgres database at database <name>",
			},
			slot: {
				kind: "boolean",
				description:
					"Hold one of the machine-wide check slots (BUNCARGO_CHECK_SLOTS, default 3) while it runs",
			},
		},
		passthrough: "Required: the command; following arguments pass unchanged",
	},
	exits: {
		...BASE_EXITS,
		1: "bad arguments; otherwise the command's own code",
	},
	run: ({ values, passthrough }) => {
		if (passthrough.length === 0)
			throw argumentsError(["Provide a command after --"], "exec");
		return exec({ ...values, command: [...passthrough] });
	},
});

async function exec(parsed: {
	app: string | undefined;
	cwd: string | undefined;
	db: string | undefined;
	slot: boolean;
	command: string[];
}): Promise<number> {
	const env = await loadDevEnv();
	const databaseEnv =
		parsed.db === undefined
			? undefined
			: await databaseOverrides(env, parsed.app, parsed.db, {
					exists: databaseExists,
					inherited: process.env,
				});
	if (databaseEnv)
		console.error(
			`${Object.keys(databaseEnv).join(", ")} → database ${parsed.db}`,
		);
	const run = () =>
		runForwardingSignals((signal) =>
			env.exec(parsed.command, {
				app: parsed.app,
				cwd: parsed.cwd,
				verbose: true,
				throwOnError: false,
				signal,
				env: databaseEnv,
			}),
		);
	if (!parsed.slot) return run();

	return withCheckSlot(parsed.command.join(" ").slice(0, 60), run, {
		...processCheckSlot,
		onWait: (wait) => console.error(formatCheckSlotWait(wait)),
	});
}
