import { statSync } from "node:fs";

/**
 * Whether a checkout directory is still there, as far as this user can tell.
 *
 * `deleted` only when the path is confirmed missing (`ENOENT`). Any other
 * failure, such as another user's home this one cannot enter, is `unknown`:
 * `existsSync` reads that as false, and a watchdog running as one user once
 * took every checkout of the CI user's home for deleted and tore its stacks
 * down, a live E2E run's included. So cleanup asks this, and treats `unknown`
 * as present.
 */
export type CheckoutPresence = "present" | "deleted" | "unknown";

export function checkoutPresence(root: string): CheckoutPresence {
	if (root === "") return "unknown";
	try {
		statSync(root);
		return "present";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? "deleted"
			: "unknown";
	}
}

/** True only for a checkout confirmed gone. */
export function checkoutDeleted(root: string): boolean {
	return checkoutPresence(root) === "deleted";
}
