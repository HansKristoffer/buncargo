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
	return new CliError(error instanceof Error ? error.message : String(error));
}
