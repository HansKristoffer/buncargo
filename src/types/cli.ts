// ═══════════════════════════════════════════════════════════════════════════
// CLI Options
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How the port offset was chosen. `unallocated`: a read of a checkout that has
 * no block yet found every block of the range claimed; the offset is the
 * hashed one and its ports are another checkout's. The next `buncargo dev`
 * allocates, reclaiming an idle checkout's block if it has to.
 */
export type PortOffsetProvenance =
	"hash" | "claim" | "env" | "shifted" | "unallocated";

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
