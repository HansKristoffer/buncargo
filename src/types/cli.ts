// ═══════════════════════════════════════════════════════════════════════════
// CLI Options
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How the port offset was chosen.
 */
export type PortOffsetProvenance = "hash" | "lockfile" | "env" | "shifted";

/**
 * Options for the CLI runner.
 */
export interface CliOptions {
	/** Custom args (defaults to process.argv.slice(2)) */
	args?: string[];
	/**
	 * Start the watchdog that removes this run's containers once it is gone
	 * (default: true). The run still claims its containers with `false`; this
	 * only skips starting the process. Tests set false.
	 */
	watchdog?: boolean;
}
