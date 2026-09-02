import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isProcessAlive } from "./process/lifecycle";

/**
 * A cross-process advisory lock for the state files several buncargo runs
 * share (`~/.buncargo/routes.json`, `.buncargo/public-tunnels.json`).
 *
 * Those registries are read-modify-write: without a lock, two `buncargo dev`
 * runs starting at the same moment both read the same snapshot and the second
 * write drops the first one's routes, so a project's named URL silently 404s.
 *
 * Deliberately advisory and self-healing rather than strict. A dev tool must
 * never deadlock because a previous run was killed with the lock held, so a
 * holder that has died or gone quiet is evicted, and acquisition always
 * resolves.
 */

const LOCK_POLL_MS = 20;
/** A holder that stops making progress is treated as gone. */
export const LOCK_STALE_MS = 10_000;
/** Upper bound on waiting before the lock is broken and taken anyway. */
export const LOCK_TIMEOUT_MS = 5000;

interface LockHolder {
	pid: number;
	at: number;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockPathFor(target: string): string {
	return `${target}.lock`;
}

async function tryAcquire(lockPath: string): Promise<boolean> {
	try {
		// O_CREAT | O_EXCL: creation is the atomic step that decides the winner.
		const handle = await open(lockPath, "wx");
		try {
			const holder: LockHolder = { pid: process.pid, at: Date.now() };
			await handle.writeFile(JSON.stringify(holder));
		} finally {
			await handle.close();
		}
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

async function releaseQuietly(lockPath: string): Promise<void> {
	try {
		await unlink(lockPath);
	} catch {
		// already released, or broken by a waiter that timed out
	}
}

/** Drop a lock whose owner died, or which has simply gone stale. */
async function evictDeadHolder(lockPath: string): Promise<void> {
	let raw: string;
	try {
		raw = await readFile(lockPath, "utf-8");
	} catch {
		return;
	}

	try {
		const holder = JSON.parse(raw) as Partial<LockHolder>;
		const ownerGone =
			typeof holder.pid === "number" && !isProcessAlive(holder.pid);
		const tooOld =
			typeof holder.at === "number" && Date.now() - holder.at > LOCK_STALE_MS;
		if (ownerGone || tooOld) {
			await releaseQuietly(lockPath);
		}
	} catch {
		// Unparseable: either a torn write from a holder mid-acquire, or junk.
		// Age it out rather than break a lock that was created microseconds ago.
		try {
			const stats = await stat(lockPath);
			if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
				await releaseQuietly(lockPath);
			}
		} catch {
			// gone
		}
	}
}

/**
 * Run `operation` with exclusive access to `target`.
 *
 * Always runs the operation: if the lock cannot be taken within
 * `LOCK_TIMEOUT_MS`, the holder is presumed wedged and the lock is broken.
 * Losing an update is strictly better than hanging a dev run forever.
 */
export async function withFileLock<T>(
	target: string,
	operation: () => Promise<T>,
): Promise<T> {
	const lockPath = lockPathFor(target);
	await mkdir(dirname(lockPath), { recursive: true });

	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let held = await tryAcquire(lockPath);
	while (!held) {
		if (Date.now() >= deadline) {
			await releaseQuietly(lockPath);
			held = await tryAcquire(lockPath);
			break;
		}
		await evictDeadHolder(lockPath);
		// Jitter so waiters released together do not collide on the next attempt.
		await delay(LOCK_POLL_MS + Math.random() * LOCK_POLL_MS);
		held = await tryAcquire(lockPath);
	}

	try {
		return await operation();
	} finally {
		if (held) await releaseQuietly(lockPath);
	}
}
