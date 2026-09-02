/**
 * Wait for a number of milliseconds.
 *
 * Its own leaf module rather than part of `core/utils`, which also holds
 * `getEnvVar` and so reaches for port allocation, the host plan and the
 * network helpers. The hosts daemon needs nothing but this, and importing it
 * from there pulled that whole graph into the single file a root launchd job
 * executes.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
