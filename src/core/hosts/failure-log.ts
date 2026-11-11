/** Minimum gap between two reload-failure lines, whatever the cause. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

export interface ThrottledFailureLog {
	/** Log this failure unless one was already logged inside the interval. */
	report: (message: string) => void;
	/** Note a success, so the next failure is reported immediately. */
	reset: () => void;
}

/**
 * Bound how fast a persistent failure can fill `/var/log/buncargo-hosts.log`.
 *
 * Suppressing repeats of an identical message is not enough on its own: a
 * certificate gap names the hostnames it is missing, so every app that registers
 * or expires produces a fresh message and every one of them gets through. A
 * stale service can hold that state for hours. Throttling by time instead caps
 * the file at one line a minute and carries the suppressed count, so an ongoing
 * failure stays visible — including whether it is still changing — without the
 * log growing without bound.
 */
export function createThrottledFailureLog(deps: {
	log: (message: string) => void;
	now: () => number;
	intervalMs?: number;
}): ThrottledFailureLog {
	const intervalMs = deps.intervalMs ?? FAILURE_LOG_INTERVAL_MS;
	let lastLoggedAt: number | undefined;
	let suppressed = 0;

	return {
		report(message: string) {
			const now = deps.now();

			if (lastLoggedAt !== undefined && now - lastLoggedAt < intervalMs) {
				suppressed += 1;

				return;
			}

			const suffix =
				suppressed > 0
					? ` (${suppressed} further ${suppressed === 1 ? "failure" : "failures"} suppressed)`
					: "";

			deps.log(`${message}${suffix}`);
			lastLoggedAt = now;
			suppressed = 0;
		},
		reset() {
			lastLoggedAt = undefined;
			suppressed = 0;
		},
	};
}
