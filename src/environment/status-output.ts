/**
 * Where an environment reports its progress, and the output of the commands
 * it runs for itself (Prisma generate, the seed).
 *
 * The terminal by default. A wrapper whose stdout belongs to the command it
 * wraps (`buncargo ci -- bun test > report.txt`) points both at stderr.
 */
export interface StatusOutput {
	/** One line of the environment's own progress. */
	log(line: string): void;
	/**
	 * Takes each line a command prints, instead of the command writing to
	 * the inherited stdout. Undefined: it writes there itself, keeping a
	 * terminal's colours and redraws.
	 */
	readonly commandLine?: (line: string) => void;
}

export const TERMINAL_OUTPUT: StatusOutput = {
	log: (line) => console.log(line),
};

export const STDERR_OUTPUT: StatusOutput = {
	log: (line) => console.error(line),
	commandLine: (line) => console.error(line),
};
