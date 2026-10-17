import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "./process/lifecycle";
import { readProcessIdentityAsync } from "./process-identity";
import { buncargoVersion } from "./version";
import { readWatchdogOwnerAsync } from "./watchdog";

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
			// The same code as any CLI the test starts, so none replaces it.
			version: buncargoVersion(),
		}),
	);
}

/**
 * Stop the watchdog the current `HOME`'s pid file names, if that is still the
 * process recorded and not this one, and wait for it to exit: one that is
 * still writing its log would recreate a home its caller is about to delete.
 */
export async function stopWatchdog(): Promise<void> {
	const owner = await readWatchdogOwnerAsync();
	if (!owner || owner.pid === process.pid) return;
	if (owner.processIdentity === undefined) return;

	try {
		process.kill(owner.pid, "SIGTERM");
	} catch {
		// It exited between the check and the signal.
		return;
	}
	const deadline = Date.now() + 5000;
	while (isProcessAlive(owner.pid) && Date.now() < deadline)
		await Bun.sleep(20);
}
