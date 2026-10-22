import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A checkout this user cannot see into: `root` sits in a directory with mode
 * 000, like another user's home. Undefined when running as root, which reads
 * through any mode.
 */
export function unreadableCheckout():
	{ root: string; cleanup: () => void } | undefined {
	if (process.getuid?.() === 0) return undefined;
	const parent = mkdtempSync(join(tmpdir(), "buncargo-unreadable-"));
	const root = join(parent, "checkout");
	mkdirSync(root);
	chmodSync(parent, 0o000);
	return {
		root,
		cleanup: () => {
			chmodSync(parent, 0o700);
			rmSync(parent, { recursive: true, force: true });
		},
	};
}
