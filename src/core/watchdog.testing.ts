import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProcessIdentityAsync } from "./process-identity";

/**
 * Record this test process as the watchdog of the state directory under
 * `home`, so a CLI run started there finds one running and starts none.
 *
 * A run ensures the machine's watchdog once its apps are up. Started from a
 * test's temporary `HOME`, a real one would outlive the test by a sweep
 * interval and take the tailnet directory's port. The test process is alive
 * for exactly as long as the runs it starts, which is all the check asks.
 */
export async function standInForWatchdog(home: string): Promise<void> {
	mkdirSync(join(home, ".buncargo"), { recursive: true });
	writeFileSync(
		join(home, ".buncargo", "watchdog.pid"),
		JSON.stringify({
			pid: process.pid,
			processIdentity: await readProcessIdentityAsync(process.pid),
		}),
	);
}
