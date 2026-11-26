import { EventEmitter } from "node:events";
import { isProcessAlive } from "./lifecycle";

/**
 * A daemonized server has no ChildProcess handle, but is still owned by this
 * run. Watched with `kill(pid, 0)`, which forks nothing; its identity is read
 * only before it is signalled (`terminate.ts`), since a recycled pid must
 * never be signalled, while a recycled pid that merely looks alive is only
 * noticed late.
 */
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
		this.timer = setInterval(() => {
			if (isProcessAlive(this.pid)) return;
			this.dispose();
			this.exitCode = 0;
			this.emit("exit", 0, null);
		}, 1000);
	}

	dispose(): void {
		clearInterval(this.timer);
	}
}
