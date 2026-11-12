import { getErrorMessage } from "hanzio";
import { InfisicalLoginError, SecretsError } from "../core/secrets/errors";
/**
 * A user-facing CLI failure: printed as `❌ message` plus optional hint lines,
 * then exit 1. Throw this instead of calling `process.exit` mid-flow so the
 * command can still release ports, tunnels and host routes on the way out.
 */
export class CliError extends Error {
	readonly hints: string[];

	constructor(message: string, hints: string[] = []) {
		super(message);
		this.name = "CliError";
		this.hints = hints;
	}
}

export function toCliError(error: unknown): CliError {
	if (error instanceof CliError) {
		return error;
	}
	// The fix is the point: an expired Infisical session names its login.
	if (error instanceof InfisicalLoginError) {
		return new CliError(error.reason, [`Fix: ${error.login}`]);
	}
	if (error instanceof SecretsError) {
		return new CliError(error.message, error.fix ? [`Fix: ${error.fix}`] : []);
	}
	return new CliError(getErrorMessage(error));
}

/** An argv problem: `runCommand` prints it and exits 1. */
export class ArgumentsError extends CliError {}

/** Argv problems: the first as the message, the rest as hints, then where help is. */
export function argumentsError(
	errors: readonly string[],
	command: string,
): ArgumentsError {
	return new ArgumentsError(errors[0] ?? "Invalid arguments.", [
		...errors.slice(1),
		`Run "bunx buncargo ${command} --help" for options.`,
	]);
}
