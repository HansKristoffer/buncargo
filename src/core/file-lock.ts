import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { abortableSleep } from "./deadline";
import { isProcessAlive } from "./process/lifecycle";
import { recordStartupMetric } from "./startup-metrics";
import { chownToInvokingUser } from "./state-paths";

const LOCK_POLL_MS = 20;
/** @deprecated Age never grants ownership of a live process's lock. */
export const LOCK_STALE_MS = 10_000;
export const LOCK_TIMEOUT_MS = 5000;

export class FileLockTimeoutError extends Error {
	readonly code = "BUNCARGO_LOCK_TIMEOUT";
	constructor(
		readonly target: string,
		readonly timeoutMs: number,
	) {
		super(
			`Timed out after ${timeoutMs}ms waiting for exclusive access to ${target}. Another buncargo process is still using it; retry after it finishes.`,
		);
		this.name = "FileLockTimeoutError";
	}
}

/**
 * Kernel locks are tied to the open descriptor, including when a process dies.
 * Never unlink the persistent .lock.v2 inode: another waiter may already have
 * it open, and replacing it would split the lock into two independent owners.
 *
 * Lazy loading keeps bun:ffi out of CLI import/help and Node consumers which
 * only use the pure library modules. Buncargo's runtime is Bun on macOS/Linux.
 */
let loadFlock: Promise<(fd: number) => boolean> | undefined;
function flockOperation(): Promise<(fd: number) => boolean> {
	loadFlock ??= (async () => {
		if (process.platform !== "darwin" && process.platform !== "linux") {
			throw new Error(
				"Exclusive buncargo state locking requires Bun on macOS or Linux. On Windows, run buncargo in WSL.",
			);
		}
		const { dlopen, read } = await import("bun:ffi");
		const errnoSymbol =
			process.platform === "darwin" ? "__error" : "__errno_location";
		const libraries =
			process.platform === "darwin"
				? ["/usr/lib/libSystem.B.dylib"]
				: [
						"libc.so.6",
						`/lib/ld-musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`,
					];
		let lastError: unknown;
		for (const path of libraries) {
			try {
				const library = dlopen(path, {
					flock: { args: ["i32", "i32"], returns: "i32" },
					[errnoSymbol]: { args: [], returns: "ptr" },
				});
				return (fd: number) => {
					if (library.symbols.flock(fd, 2 | 4) === 0) return true; // LOCK_EX | LOCK_NB
					const errnoPointer = library.symbols[errnoSymbol]?.();
					if (!errnoPointer) throw new Error("Could not read flock errno");
					const errno = read.i32(errnoPointer as import("bun:ffi").Pointer);
					if (errno === 11 || errno === 35 || errno === 4) return false;
					throw new Error(
						`Could not acquire buncargo file lock (errno ${errno})`,
					);
				};
			} catch (error) {
				lastError = error;
			}
		}
		throw new Error("Could not load the operating system file lock primitive", {
			cause: lastError,
		});
	})();
	return loadFlock;
}

/**
 * Do not overlap an older CLI already holding its legacy lock during upgrade.
 * No legacy file is removed here: check/unlink would race a replacement owner.
 * Old versions cannot honor the v2 protocol, so stop old dev sessions and
 * restart the hosts service when upgrading before mixing concurrent writers.
 */
async function legacyHolderActive(target: string): Promise<boolean> {
	let raw: string;
	try {
		raw = await readFile(`${target}.lock`, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	try {
		const holder: unknown = JSON.parse(raw);
		if (
			typeof holder !== "object" ||
			holder === null ||
			!("pid" in holder) ||
			typeof holder.pid !== "number" ||
			!Number.isInteger(holder.pid) ||
			holder.pid <= 0
		)
			return true;
		return isProcessAlive(holder.pid);
	} catch {
		return true;
	}
}

/** Run a mutation exclusively, or reject on bounded contention without running it. */
export async function withFileLock<T>(
	target: string,
	operation: () => Promise<T>,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
	options.signal?.throwIfAborted();
	const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
		throw new Error("Lock timeout must be a non-negative finite duration");
	const startedAt = performance.now();
	const deadline = startedAt + timeoutMs;
	const flock = await flockOperation();
	const lockPath = `${target}.lock.v2`;
	await mkdir(dirname(lockPath), { recursive: true });
	const handle = await open(lockPath, "a+", 0o600);
	chownToInvokingUser(lockPath);
	try {
		for (;;) {
			options.signal?.throwIfAborted();
			if (flock(handle.fd) && !(await legacyHolderActive(target))) break;
			const remaining = deadline - performance.now();
			if (remaining <= 0) {
				recordStartupMetric("lock timeouts");
				throw new FileLockTimeoutError(target, timeoutMs);
			}
			await abortableSleep(
				Math.min(remaining, LOCK_POLL_MS + Math.random() * LOCK_POLL_MS),
				options.signal,
			);
		}
		recordStartupMetric("lock wait ms", performance.now() - startedAt);
		options.signal?.throwIfAborted();
		return await operation();
	} finally {
		// close also releases ownership after throws. Process death closes it in
		// the kernel, so no stale timer, PID eviction or release unlink is needed.
		await handle.close();
	}
}
