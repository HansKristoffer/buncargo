/** Idle backstop after a clean exit, unless the run chose another. */
export const WATCHDOG_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * How long a crashed run's containers are kept before they are reclaimed.
 *
 * Reached only once the owning process is gone without releasing, so it
 * covers a crash rather than a clean exit. Counted from `ownerLostAt`, which
 * the sweep stamps the first time it notices — one write per crash, and none
 * while runs are healthy. It used to be counted from `updatedAt`, which a
 * quiet run may not have written for hours, so such a run lost its
 * containers on the very next pass.
 */
export const WATCHDOG_OWNER_DEAD_GRACE_MS = 15_000;

/**
 * How often the watchdog sweeps.
 *
 * The shortest window it has to resolve is the crash grace above, so a
 * shorter period buys nothing: a stack removed 30s after its owner died
 * rather than 15s costs nobody anything, and this process runs forever on an
 * otherwise idle machine.
 */
export const WATCHDOG_POLL_INTERVAL_MS = 30_000;
