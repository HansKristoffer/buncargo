import { EventEmitter } from "node:events";
import {
	processIdentityMatcherAsync,
	readProcessIdentityAsync,
} from "../process-identity";
import { execAsync } from "./exec";
import { createPortOwnerSnapshotAsync } from "./port-owner";

/** A daemonized server has no ChildProcess handle, but is still owned by this run. */
export class DetachedApp extends EventEmitter {
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	private timer?: ReturnType<typeof setInterval>;
	constructor(
		readonly pid: number,
		readonly identity: string,
	) {
		super();
	}
	watch(): void {
		let checking = false;
		this.timer = setInterval(async () => {
			if (checking) return;
			checking = true;
			try {
				const alive = await processIdentityMatcherAsync([
					{ pid: this.pid, processIdentity: this.identity },
				]);
				if (!alive(this.pid, this.identity)) {
					this.dispose();
					this.exitCode = 0;
					this.emit("exit", 0, null);
				}
			} catch {
				// Inspection failure preserves supervision; signalling remains strict.
			} finally {
				checking = false;
			}
		}, 1000);
	}
	dispose(): void {
		clearInterval(this.timer);
	}
}

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
	if (!owner?.pids.length) return;
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
		if (identity)
			return { child: new DetachedApp(pid, identity), command: owner.command };
	}
}
