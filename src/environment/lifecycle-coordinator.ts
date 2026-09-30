import { abortError } from "../core/deadline";

/** Coordinates mutations of one environment; independent environments never share it. */
export class LifecycleCoordinator {
	private startup?: Promise<unknown>;
	private startupController?: AbortController;
	private transitions = 0;
	private tail: Promise<unknown> = Promise.resolve();
	private restarting?: { controller: AbortController; promise: Promise<void> };
	private sessions = new Set<{ controller: AbortController; detach(): void }>();

	start<T>(
		work: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
		retainCancellation: (result: T) => boolean = () => true,
	): Promise<T> {
		if (this.startup || this.transitions) {
			const phase = this.startup ? "starting" : "changing its lifecycle";
			return Promise.reject(
				new Error(
					`This environment is already ${phase}. Wait for the current operation, or use loadDevEnv({ fresh: true }) for an independent session.`,
				),
			);
		}
		return this.runStart(work, signal, retainCancellation);
	}

	private runStart<T>(
		work: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
		retainCancellation: (result: T) => boolean = () => true,
	): Promise<T> {
		const controller = new AbortController();
		const cancel = () => controller.abort(abortError(signal));
		const session = {
			controller,
			detach: () => signal?.removeEventListener("abort", cancel),
		};
		const release = () => {
			session.detach();
			this.sessions.delete(session);
		};
		controller.signal.addEventListener("abort", release, { once: true });
		if (signal?.aborted) cancel();
		else signal?.addEventListener("abort", cancel, { once: true });
		this.sessions.add(session);
		this.startupController = controller;
		const operation = Promise.resolve()
			.then(() => {
				controller.signal.throwIfAborted();
				return work(controller.signal);
			})
			.then((result) => {
				if (!retainCancellation(result)) release();
				return result;
			})
			.catch((error) => {
				release();
				throw error;
			})
			.finally(() => {
				this.startup = undefined;
				this.startupController = undefined;
			});
		this.startup = operation;
		return operation;
	}

	private schedule(work: () => Promise<void>): Promise<void> {
		this.transitions++;
		const operation = this.tail.then(work).finally(() => this.transitions--);
		// A failed transition must not poison subsequent cleanup requests.
		this.tail = operation.catch(() => {});
		return operation;
	}

	private cancelStartup(): Promise<unknown> | undefined {
		const startup = this.startup;
		this.startupController?.abort(new Error("Startup cancelled by stop"));
		return startup?.catch(() => {});
	}

	private releaseSessions(): void {
		for (const session of this.sessions) {
			session.detach();
			session.controller.abort(new Error("Environment stopped"));
		}
		this.sessions.clear();
	}

	stop(work: () => Promise<void>, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(abortError(signal));
		this.restarting?.controller.abort(new Error("Restart cancelled by stop"));
		const startup = this.cancelStartup();
		return this.schedule(async () => {
			await startup;
			signal?.throwIfAborted();
			await work();
			this.releaseSessions();
		});
	}

	/** Concurrent restarts share one teardown/start; stop supersedes it. */
	restart(
		stop: (signal: AbortSignal) => Promise<void>,
		start: (signal: AbortSignal) => Promise<unknown>,
	): Promise<void> {
		if (this.restarting) return this.restarting.promise;
		const controller = new AbortController();
		const startup = this.cancelStartup();
		const promise = this.schedule(async () => {
			await startup;
			controller.signal.throwIfAborted();
			await stop(controller.signal);
			this.releaseSessions();
			controller.signal.throwIfAborted();
			await this.runStart(start, controller.signal, () => false);
		}).finally(() => {
			this.restarting = undefined;
		});
		this.restarting = { controller, promise };
		return promise;
	}
}
