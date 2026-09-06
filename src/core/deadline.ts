export class DeadlineExceededError extends Error {}

const abortCleanups = new WeakMap<AbortSignal, Set<Promise<unknown>>>();

/** Executors acknowledge cancellation only after their owned process has exited. */
export function registerAbortCleanup(
	signal: AbortSignal,
	cleanup: Promise<unknown>,
): void {
	let pending = abortCleanups.get(signal);
	if (!pending) {
		pending = new Set();
		abortCleanups.set(signal, pending);
	}
	pending.add(cleanup);
	void cleanup.finally(() => pending.delete(cleanup)).catch(() => {});
}

async function finishAbortCleanup(signal: AbortSignal): Promise<void> {
	// Let every listener in this abort dispatch register its bounded cleanup.
	await Promise.resolve();
	const pending = abortCleanups.get(signal);
	if (pending?.size) await Promise.allSettled([...pending]);
}

/** Monotonic elapsed-time budgets shared by probes and child processes. */
export function remainingTime(deadline: number): number {
	return Math.max(0, deadline - performance.now());
}

export function abortError(signal?: AbortSignal): Error {
	return signal?.reason instanceof Error
		? signal.reason
		: new Error("Operation cancelled", { cause: signal?.reason });
}

/** Stops awaiting even callbacks which do not cooperate with cancellation. */
export function withSignal<T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) {
		void operation.catch(() => {});
		return finishAbortCleanup(signal).then(() => {
			throw abortError(signal);
		});
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			void finishAbortCleanup(signal).then(() => reject(abortError(signal)));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation
			.then(
				(value) => {
					if (!signal.aborted) resolve(value);
				},
				(error) => {
					if (!signal.aborted) reject(error);
				},
			)
			.finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export async function withDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T> {
	const controller = new AbortController();
	const cancel = () => {
		controller.abort(abortError(signal));
		if (signal)
			registerAbortCleanup(signal, finishAbortCleanup(controller.signal));
	};
	if (signal?.aborted) cancel();
	else signal?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(
		() =>
			controller.abort(
				new DeadlineExceededError(`Operation timed out after ${timeoutMs}ms`),
			),
		Math.max(0, timeoutMs),
	);
	try {
		controller.signal.throwIfAborted();
		return await withSignal(
			Promise.resolve().then(() => operation(controller.signal)),
			controller.signal,
		);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
	}
}

export function abortableSleep(
	ms: number,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError(signal));
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(signal));
		};
		const timer = setTimeout(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
