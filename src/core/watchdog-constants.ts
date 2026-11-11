/** Idle backstop after a clean exit, unless the run chose another. */
export const WATCHDOG_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * How long a crashed run's containers are kept before they are reclaimed.
 *
 * Reached only once the owning process is gone without releasing, so it
 * covers a crash rather than a clean exit. Counted from a `lost` lifecycle's `at`, which
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

/**
 * How long a checkout must stay deleted, from the watchdog's first sighting
 * to a later pass, before `BUNCARGO_PRUNE_DELETED_CHECKOUTS` removes its
 * volumes, and before the watchdog stops a detached run still serving it.
 */
export const DELETED_CHECKOUT_SETTLE_MS = 10 * 60_000;

/**
 * How long a `dev --detach` run may go with no request through buncargo's
 * proxy and no buncargo command in its checkout before the watchdog stops
 * it. `dev --detach --keep` opts out.
 */
export const DETACHED_IDLE_LIMIT_MS = 2 * 60 * 60_000;
