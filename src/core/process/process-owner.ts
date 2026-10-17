import type { EventEmitter } from "node:events";
import { abortError, withSignal } from "../deadline";
import { formatWarn } from "../style";
import { DetachedApp, findDetachedApp } from "./detached-app";
import type { AppChild } from "./pty-app";
import {
	ownedProcessAlive,
	ownedProcessGone,
	terminateOwnedProcess,
} from "./terminate";

export class RunInterrupted extends Error {}

/**
 * Did this app stop because something asked it to?
 *
 * `null` is a process killed by a signal outright. The two codes are
 * `128 + SIGINT` and `128 + SIGTERM`, which is what a shell wrapper reports
 * when the signal reached it rather than the server it spawned — `bun run dev`
 * does exactly that. Without them a Ctrl-C, or a `buncargo stop`, ends a clean
 * shutdown with "App exited with code 143" and a failed run.
 */
export function isDeliberateExit(
	code: number | null,
	signal?: NodeJS.Signals | null,
): boolean {
	return (
		(code === null &&
			(signal === undefined || signal === "SIGINT" || signal === "SIGTERM")) ||
		code === 0 ||
		code === 130 ||
		code === 143
	);
}

/**
 * How an app's exit reads: `stopped` when something asked it to stop, else
 * `failed`. A worker is meant to run until it is stopped, so an essential
 * one exiting 0 failed; a non-essential one (or one parked after it never
 * came up) only stopped. The supervisor, the stream and TUI rows and the run
 * registry all read an exit through this.
 */
export function appExitState(
	code: number | null,
	signal: NodeJS.Signals | null | undefined,
	app: { worker: boolean; optional: boolean },
): "stopped" | "failed" {
	if (code === 0 && app.worker && !app.optional) return "failed";
	return isDeliberateExit(code, signal) ? "stopped" : "failed";
}

/** Owns only children created by one startDevServers invocation. */
export class ProcessOwner {
	readonly controller = new AbortController();
	private children = new Set<AppChild | DetachedApp>();
	private live = new Set<AppChild | DetachedApp>();
	private retired = new Set<AppChild | DetachedApp>();
	private sealed = false;
	private exits = new Set<Promise<void>>();
	private pendingReadiness = new Set<string>();
	/** Non-essential apps that exited: the run waits for a restart, not for them. */
	private parked = new Set<string>();
	private warnedDetaches = new Set<string>();
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
			/** Apps with `essential: false`: their exit never ends the run. */
			optional?: ReadonlySet<string>;
			onAppAdopted?: (name: string, child: DetachedApp) => void;
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
		child: AppChild | DetachedApp,
		needsReadiness = true,
		worker = false,
		port?: number,
	): void {
		if (needsReadiness) this.pendingReadiness.add(name);
		this.parked.delete(name);
		this.children.add(child);
		this.live.add(child);
		(child as EventEmitter).once("error", (error: Error) => {
			this.live.delete(child);
			this.controller.abort(
				new Error(`Failed to start app "${name}": ${error.message}`),
			);
		});
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			const operation = (async () => {
				// Replaced on purpose (`restartOn`): its exit is not the app's.
				if (this.retired.delete(child)) {
					this.live.delete(child);
					// Replacement owns this gap; retiring the last child is not completion.
					return;
				}
				if (
					code === 0 &&
					!worker &&
					port !== undefined &&
					child.pid &&
					!(child instanceof DetachedApp)
				) {
					const detached = await findDetachedApp(port, child.pid);
					if (detached) {
						this.live.delete(child);
						this.forgetIfGone(child);
						this.register(
							name,
							detached.child,
							this.pendingReadiness.has(name),
						);
						this.options.onAppAdopted?.(name, detached.child);
						if (!this.warnedDetaches.has(name)) {
							this.warnedDetaches.add(name);
							console.warn(
								formatWarn(
									`App "${name}" on port ${port}, pid ${detached.child.pid} (${detached.command ?? "unknown command"}): the app detached from buncargo; it will be stopped with the run`,
								),
							);
						}
						if (this.controller.signal.aborted)
							await terminateOwnedProcess(
								detached.child,
								this.options.shutdownGraceMs,
							);
						else detached.child.watch();
						return;
					}
				}
				this.live.delete(child);
				this.forgetIfGone(child);
				try {
					this.options.onAppExit?.(name, code, signal);
				} catch {
					/* Observers cannot break process cleanup. */
				}
				const deliberate =
					appExitState(code, signal, {
						worker,
						optional: this.options.optional?.has(name) ?? false,
					}) === "stopped";
				if (
					this.options.optional?.has(name) &&
					!this.controller.signal.aborted
				) {
					this.pendingReadiness.delete(name);
					this.parked.add(name);
				} else if (!this.controller.signal.aborted) {
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
				if (this.sealed && this.live.size === 0 && this.parked.size === 0)
					this.resolveDone();
			})();
			this.exits.add(operation);
			void operation
				.catch((error) => this.controller.abort(error))
				.finally(() => this.exits.delete(operation));
		};
		// A child can be gone before it is registered: a worker that crashed
		// while its ownership was being claimed. Its exit counts all the same.
		if (child.exitCode !== null || child.signalCode !== null)
			queueMicrotask(() => onExit(child.exitCode, child.signalCode));
		else (child as EventEmitter).once("exit", onExit);
	}

	/**
	 * A child whose exit was seen and whose group is gone has nothing left to
	 * stop, and its pid may already belong to an unrelated process. A group
	 * that outlives its leader is forgotten once it empties.
	 */
	private forgetIfGone(child: AppChild | DetachedApp): void {
		if (!ownedProcessAlive(child)) this.children.delete(child);
		else void ownedProcessGone(child).then(() => this.children.delete(child));
	}

	/**
	 * Stop one child because it is being replaced. Its exit is not reported,
	 * and does not end the run the way an app falling over does.
	 */
	async retire(child: AppChild | DetachedApp): Promise<void> {
		this.retired.add(child);
		await terminateOwnedProcess(child, this.options.shutdownGraceMs);
		if (child instanceof DetachedApp) {
			child.dispose();
			this.live.delete(child);
			this.retired.delete(child);
		}
		this.children.delete(child);
		if (child.exitCode !== null || child.signalCode !== null)
			this.retired.delete(child);
	}

	ready(name: string): void {
		this.pendingReadiness.delete(name);
	}

	race<T>(operation: Promise<T>): Promise<T> {
		return withSignal(operation, this.controller.signal);
	}

	async wait(): Promise<void> {
		this.sealed = true;
		if (this.live.size === 0 && this.parked.size === 0) this.resolveDone();
		await this.race(this.done);
	}

	stop(): Promise<void> {
		this.cleanup ??= (async () => {
			this.controller.abort(new RunInterrupted("Run stopped"));
			await Promise.allSettled([...this.exits]);
			const results = await Promise.allSettled(
				[...this.children].map((child) =>
					terminateOwnedProcess(child, this.options.shutdownGraceMs),
				),
			);
			await Promise.allSettled([...this.exits]);
			const errors = results.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			);
			if (errors.length)
				throw new AggregateError(errors, "Failed to stop owned app processes");
		})();
		return this.cleanup;
	}

	dispose(): void {
		for (const child of this.children)
			if (child instanceof DetachedApp) child.dispose();
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
			process.off(signal, this.onSignal);
		this.options.signal?.removeEventListener("abort", this.onAbort);
	}
}
