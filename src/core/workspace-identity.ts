import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/** Stable checkout identity for cookie isolation and environment metadata. */
export function workspaceId(root: string): string {
	let canonical = root;

	try {
		canonical = realpathSync(root);
	} catch {
		// A deleted checkout keeps the identity its path gives it.
	}

	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
