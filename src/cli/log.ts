import { writeSync } from "node:fs";
import pc from "picocolors";
import { formatDone, formatFail, formatStep, formatWarn } from "../core/style";

/**
 * CLI status output.
 *
 * One place for the prefixes and stream choice so command handlers stop
 * hand-writing emoji. The rich environment banner stays in
 * `src/environment/logging.ts`; this is only for CLI-level status and errors.
 */

/** Plain line, no prefix — used for report bodies and key/value listings. */
export function line(message = ""): void {
	console.log(message);
}

export function info(message: string): void {
	console.log(formatStep(message));
}

export function success(message: string): void {
	console.log(`  ${pc.green("✅")} ${message}`);
}

/** Completed step, one notch quieter than {@link success}. */
export function done(message: string): void {
	console.log(formatDone(message));
}

export function warn(message: string): void {
	console.warn(formatWarn(message));
}

export function error(message: string): void {
	console.error(formatFail(message));
}

/** Indented continuation under an {@link error} or {@link warn}. */
export function hint(message: string): void {
	console.error(`   ${pc.dim(message)}`);
}

/**
 * Write to fd 2 without going through Bun's buffered stderr.
 *
 * Bun buffers stderr when it is not a TTY, and `process.exit` discards whatever
 * is still buffered. A fatal error printed with `console.error` right before
 * exiting is therefore lost in exactly the cases where it matters most: CI
 * logs, `2> file`, and the launchd/systemd service log.
 */
function writeStderrSync(message: string): void {
	try {
		writeSync(2, `${message}\n`);
	} catch {
		console.error(message);
	}
}

/** Report a message and exit; nothing is torn down. */
export function fail(message: string, hints: string[] = []): never {
	writeStderrSync(formatFail(message));
	for (const item of hints) {
		writeStderrSync(`   ${pc.dim(item)}`);
	}
	process.exit(1);
}
