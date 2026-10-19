import { statSync } from "node:fs";

/**
 * Whether a checkout directory is still there, as far as this user can tell.
 *
 * `deleted` only when the path is confirmed missing: `ENOENT`, or `ENOTDIR`
 * when a directory on the way is now a file. Any other failure, such as
 * another user's home this one cannot enter, is `unknown`: `existsSync` reads
 * that as false, and a watchdog running as one user once took every checkout
 * of the CI user's home for deleted and tore its stacks down, a live E2E run's
 * included. So cleanup asks this, and treats `unknown` as present.
 */
export type CheckoutPresence = "present" | "deleted" | "unknown";

export function checkoutPresence(root: string): CheckoutPresence {
	if (root === "") return "unknown";
	try {
		statSync(root);
		return "present";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? "deleted" : "unknown";
	}
}

/** True only for a checkout confirmed gone. */
export function checkoutDeleted(root: string): boolean {
	return checkoutPresence(root) === "deleted";
}

/** `~/.Trash/…`, or `/Volumes/<disk>/.Trashes/<uid>/…` on another disk. */
const TRASH_PATH = /(^|\/)\.Trash(es)?\//;

/**
 * Whether a process's working directory belongs to a checkout that was
 * thrown away: moved to the Trash (`lsof` then reports the Trash path), or
 * confirmed deleted. Such a process is nobody's dev server any more, the way
 * the sweep treats a deleted checkout's containers.
 */
export function inDiscardedCheckout(dir: string): boolean {
	return TRASH_PATH.test(dir) || checkoutDeleted(dir);
}
