import { readProcessIdentityAsync } from "../process-identity";
import { DetachedApp } from "./detached-app";
import { execAsync } from "./exec";
import { createPortOwnerSnapshotAsync } from "./port-owner";

/**
 * The server a launcher detached from its process group, found by the port it
 * listens on. Undefined when nothing outside `group` (and not this process) owns it.
 */
export async function findDetachedApp(
	port: number,
	group: number,
): Promise<{ child: DetachedApp; command?: string } | undefined> {
	const snapshot = await createPortOwnerSnapshotAsync({
		ports: [port],
		skipContainers: true,
		includeCwd: false,
	});
	const owner = snapshot.owner(port);
	if (owner?.kind !== "process") return;

	const result = await execAsync(
		["ps", "-o", "pid=,pgid=", "-p", owner.pids.join(",")],
		process.cwd(),
		{},
		{ timeoutMs: 1000, throwOnError: false },
	);
	for (const line of result.stdout.trim().split("\n")) {
		const [pid, pgid] = line.trim().split(/\s+/).map(Number);
		if (!pid || !pgid || pgid === group || pid === process.pid) continue;

		const identity = await readProcessIdentityAsync(pid);
		if (identity) {
			return { child: new DetachedApp(pid, identity), command: owner.command };
		}
	}
}
