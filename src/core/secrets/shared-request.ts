import { abortError } from "../deadline";

interface SharedRequest<T> {
	controller: AbortController;
	pending: Promise<T>;
	waiters: number;
	settled: boolean;
	/** Set once it succeeded; what {@link SharedRequestCache.forget} compares. */
	value?: T;
}

/** Successful requests are cached; each caller owns only its wait. */
export class SharedRequestCache<T> {
	private entries = new Map<string, SharedRequest<T>>();

	get(
		key: string,
		load: (signal: AbortSignal) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		signal?.throwIfAborted();
		let entry = this.entries.get(key);
		if (!entry) {
			const controller = new AbortController();
			const pending = Promise.resolve().then(() => load(controller.signal));
			entry = { controller, pending, waiters: 0, settled: false };
			this.entries.set(key, entry);
			const created = entry;
			void pending.then(
				(value) => {
					created.settled = true;
					created.value = value;
				},
				() => {
					created.settled = true;
					if (this.entries.get(key) === created) this.entries.delete(key);
				},
			);
		}

		const request = entry;
		request.waiters++;
		return new Promise<T>((resolve, reject) => {
			let finished = false;
			const leave = () => {
				finished = true;
				request.waiters--;
				signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				if (finished) return;
				leave();
				if (!request.settled && request.waiters === 0) {
					// Evict before aborting so a new caller can retry immediately.
					if (this.entries.get(key) === request) this.entries.delete(key);
					request.controller.abort(abortError(signal));
					// The last caller acknowledges cancellation after owned work
					// has drained, including the authentication CLI's file lock.
					void request.pending.then(
						() => reject(abortError(signal)),
						() => reject(abortError(signal)),
					);
				} else {
					reject(abortError(signal));
				}
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			void request.pending.then(
				(value) => {
					if (finished) return;
					leave();
					resolve(value);
				},
				(error) => {
					if (finished) return;
					leave();
					reject(error);
				},
			);
		});
	}

	/**
	 * Drop `key`'s cached `value`, which turned out to be no good, so the next
	 * `get` loads again. A newer load another caller already started is kept.
	 */
	forget(key: string, value: T): void {
		const entry = this.entries.get(key);
		if (entry?.settled && entry.value === value) this.entries.delete(key);
	}

	clear(): void {
		for (const request of this.entries.values()) {
			if (!request.settled)
				request.controller.abort(new Error("Secret request cache cleared"));
		}
		this.entries.clear();
	}
}
