/** Idle backstop used only when the owning CLI process is also gone. */
export const WATCHDOG_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/** How often the CLI writes the heartbeat file. */
export const WATCHDOG_HEARTBEAT_INTERVAL_MS = 10_000;

/** How often the watchdog runner polls. */
export const WATCHDOG_POLL_INTERVAL_MS = 10_000;

/** Wait after the owner PID dies before tearing down (covers fast restart). */
export const WATCHDOG_OWNER_DEAD_GRACE_MS = 15_000;

/** Treat a poll gap larger than this as machine sleep and reset the idle clock. */
export const WATCHDOG_SLEEP_JUMP_MS = 30_000;

export const WATCHDOG_DEFAULT_TIMEOUT_MINUTES =
	WATCHDOG_IDLE_TIMEOUT_MS / 60_000;
