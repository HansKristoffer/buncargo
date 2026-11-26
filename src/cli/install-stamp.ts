import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findLockfile } from "../core/package-manager";

/**
 * `node_modules/.buncargo-lock-hash`: the hash of the lockfile (`bun.lock`,
 * `pnpm-lock.yaml`, …) that the last install buncargo ran (the version guard's)
 * installed.
 *
 * Package managers write nothing into `node_modules` on an install that changes
 * nothing, so its own files cannot say whether `node_modules` caught up with
 * the lockfile. A hash rather than a time: `git checkout` rewrites the lockfile
 * without changing it, and that must not reinstall.
 */
const INSTALL_STAMP = ".buncargo-lock-hash";

export function installStampPath(dir: string): string {
	return join(dir, "node_modules", INSTALL_STAMP);
}

/** The hash of `dir`'s lockfile (`bun.lock`, `pnpm-lock.yaml`, …), or `undefined` without one. */
export function lockfileHash(dir: string): string | undefined {
	const found = findLockfile(dir);
	if (!found) return undefined;
	try {
		return Bun.hash(readFileSync(found.path)).toString();
	} catch {
		return undefined;
	}
}

export function readInstallStamp(dir: string): string | undefined {
	try {
		return readFileSync(installStampPath(dir), "utf8");
	} catch {
		return undefined;
	}
}

export function writeInstallStamp(dir: string, hash: string): void {
	writeFileSync(installStampPath(dir), hash);
}
