import {
	closeSync,
	fstatSync,
	openSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { findLockfile } from "../core/package-manager";

/**
 * `node_modules/.buncargo-lock-hash`: the stat + hash of the lockfile
 * (`bun.lock`, `pnpm-lock.yaml`, ...) that the last install buncargo ran (the
 * version guard's) installed.
 *
 * Package managers write nothing into `node_modules` on an install that changes
 * nothing, so its own files cannot say whether `node_modules` caught up with
 * the lockfile. Recording `${mtimeMs}:${size}:${hash}` skips reading and
 * hashing multi-MB lockfiles on the common unchanged path while falling back to
 * the content hash when `git checkout` rewrites mtime without changing content.
 */
const INSTALL_STAMP = ".buncargo-lock-hash";

export function installStampPath(dir: string): string {
	return join(dir, "node_modules", INSTALL_STAMP);
}

/** Hash a lockfile at `lockPath`, or `undefined` if unreadable. */
function hashFile(lockPath: string): string | undefined {
	try {
		return Bun.hash(readFileSync(lockPath)).toString();
	} catch {
		return undefined;
	}
}

/** The hash of `dir`'s lockfile (`bun.lock`, `pnpm-lock.yaml`, ...), or `undefined` without one. */
export function lockfileHash(dir: string): string | undefined {
	const found = findLockfile(dir);
	return found ? hashFile(found.path) : undefined;
}

/**
 * A file modified within this window is "racily clean" (same millisecond +
 * size as a rewrite), so we hash it rather than trusting `mtimeMs:size`.
 */
const RACY_STAT_WINDOW_MS = 2_000;

/** The stamp to record after installing from `dir`'s lockfile (`mtimeMs:size:hash`). */
export function lockfileStamp(dir: string): string | undefined {
	const found = findLockfile(dir);
	if (!found) return undefined;
	try {
		const fd = openSync(found.path, "r");
		try {
			const stat = fstatSync(fd);
			const hash = Bun.hash(readFileSync(fd)).toString();
			return `${stat.mtimeMs}:${stat.size}:${hash}`;
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

/** Whether `stamp` still matches `lockPath` (fast-pathing on matching mtime+size). */
export function stampMatchesLockfile(
	stamp: string,
	lockPath: string,
	lockStat: { mtimeMs: number; size: number },
): boolean {
	const firstColon = stamp.indexOf(":");
	const secondColon =
		firstColon === -1 ? -1 : stamp.indexOf(":", firstColon + 1);
	if (firstColon !== -1 && secondColon !== -1) {
		const stampedMtime = stamp.slice(0, firstColon);
		const stampedSize = stamp.slice(firstColon + 1, secondColon);
		if (
			Date.now() - lockStat.mtimeMs > RACY_STAT_WINDOW_MS &&
			stampedMtime === String(lockStat.mtimeMs) &&
			stampedSize === String(lockStat.size)
		) {
			return true;
		}
		return stamp.slice(secondColon + 1) === hashFile(lockPath);
	}
	return stamp === hashFile(lockPath);
}

export function readInstallStamp(dir: string): string | undefined {
	try {
		return readFileSync(installStampPath(dir), "utf8");
	} catch {
		return undefined;
	}
}

export function writeInstallStamp(dir: string, stamp: string): void {
	writeFileSync(installStampPath(dir), stamp);
}
