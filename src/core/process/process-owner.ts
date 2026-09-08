import type { ChildProcess } from "node:child_process";
import { abortError, withSignal } from "../deadline";
import { terminateOwnedProcess } from "./terminate";

export class RunInterrupted extends Error {}

/** Owns only children created by one startDevServers invocation. */
export class ProcessOwner {
	readonly controller = new AbortController();
	private children: ChildProcess[] = [];
	private live = new Set<ChildProcess>();
	private sealed = false;
	private pendingReadiness = new Set<string>();
	private cleanup?: Promise<void>;
	private resolveDone!: () => void;
	private readonly done = new Promise<void>((resolve) => {
		this.resolveDone = resolve;
	});
	private readonly onSignal = () =>
		this.controller.abort(new RunInterrupted("Run interrupted"));
	private readonly onAbort = () =>
		this.controller.abort(abortError(this.options.signal));

	constructor(
		private options: {
			signal?: AbortSignal;
			shutdownGraceMs?: number;
			attachedName?: string;
			onAppExit?: (
				name: string,
				code: number | null,
				signal?: NodeJS.Signals | null,
			) => void;
		},
	) {
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
			process.on(signal, this.onSignal);
		if (options.signal?.aborted) this.onAbort();
		else
			options.signal?.addEventListener("abort", this.onAbort, { once: true });
	}

	register(
		name: string,
		child: ChildProcess,
		needsReadiness = true,
		worker = false,
	): void {
		if (needsReadiness) this.pendingReadiness.add(name);
		this.children.push(child);
		this.live.add(child);
		child.once("error", (error) => {
			this.live.delete(child);
			this.controller.abort(
				new Error(`Failed to start app "${name}": ${error.message}`),
			);
		});
		child.once("exit", (code, signal) => {
			this.live.delete(child);
			try {
				this.options.onAppExit?.(name, code, signal);
			} catch {
				/* Observers cannot break process cleanup. */
			}
			const deliberate =
				(code === 0 && !worker) ||
				code === 130 ||
				code === 143 ||
				signal === "SIGINT" ||
				signal === "SIGTERM";
			if (!this.controller.signal.aborted) {
				if (!deliberate || this.pendingReadiness.has(name))
					this.controller.abort(
						new Error(
							`App "${name}" exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
						),
					);
				else if (name === this.options.attachedName)
					this.controller.abort(
						new RunInterrupted(`Attached app "${name}" exited`),
					);
			}
			if (this.sealed && this.live.size === 0) this.resolveDone();
		});
	}

	ready(name: string): void {
		this.pendingReadiness.delete(name);
	}

	race<T>(operation: Promise<T>): Promise<T> {
		return withSignal(operation, this.controller.signal);
	}

	async wait(): Promise<void> {
		this.sealed = true;
		if (this.live.size === 0) this.resolveDone();
		await this.race(this.done);
	}

	stop(): Promise<void> {
		this.cleanup ??= (async () => {
			this.controller.abort(new RunInterrupted("Run stopped"));
			const results = await Promise.allSettled(
				this.children.map((child) =>
					terminateOwnedProcess(child, this.options.shutdownGraceMs),
				),
			);
			const errors = results.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			);
			if (errors.length)
				throw new AggregateError(errors, "Failed to stop owned app processes");
		})();
		return this.cleanup;
	}

	dispose(): void {
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
			process.off(signal, this.onSignal);
		this.options.signal?.removeEventListener("abort", this.onAbort);
	}
}
