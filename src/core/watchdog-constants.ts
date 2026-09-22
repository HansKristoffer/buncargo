/** Idle backstop after a clean exit, unless the run chose another. */
export const WATCHDOG_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * How stale an unreleased entry must be before its containers are reclaimed.
 *
 * Reached only once the owning process is gone, so it covers a crash rather
 * than a clean exit. It is measured from the entry's `updatedAt`, which is
 * written when the run claims, publishes and patches itself — not on a timer.
 * So for a run that crashed after a long quiet spell this has already elapsed,
 * and its containers go on the next sweep; the grace only really protects a
 * run that crashed shortly after doing something.
 *
 * That is the deliberate trade. Keeping it accurate would mean every live run
 * rewriting this file on an interval forever, which is the periodic writer the
 * run registry replaced, and all it would buy is reusing warm containers after
 * a crash instead of recreating them.
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
