import { CommandSignalError, type ExecResult } from "../core/process/exec";

const FORWARDED_SIGNALS: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
	["SIGINT", 130],
	["SIGTERM", 143],
	["SIGHUP", 129],
];

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

	const listeners = FORWARDED_SIGNALS.map(([signal, code]) => {
		const listener = () => {
			interrupted = code;
			controller.abort(new CommandSignalError(signal));
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
