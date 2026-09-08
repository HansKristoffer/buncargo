import { CommandSignalError } from "../../core/process";
import { loadDevEnv } from "../../loader";
import { parseExecArgs, printExecHelp } from "../exec-flags";

export async function handleExec(args: string[]): Promise<number> {
	const parsed = parseExecArgs(args);

	if (parsed.help) {
		printExecHelp();
		return 0;
	}

	if (parsed.errors.length) {
		throw new Error(parsed.errors.join("\n"));
	}

	const env = await loadDevEnv({ readOnly: true });
	const controller = new AbortController();
	let interrupted: number | undefined;

	// Forward the actual signal, but keep shell exit semantics even if the
	// child's signal handler exits successfully after its own cleanup.
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
		const result = await env.exec(parsed.command, {
			app: parsed.app,
			cwd: parsed.cwd,
			verbose: true,
			throwOnError: false,
			signal: controller.signal,
		});
		return interrupted ?? result.exitCode;
	} finally {
		for (const { signal, listener } of listeners) {
			process.off(signal, listener);
		}
	}
}
