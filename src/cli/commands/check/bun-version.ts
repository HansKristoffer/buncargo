import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The version `.bun-version` pins, when the checkout has one. */
export function pinnedBunVersion(root: string): string | undefined {
	try {
		const pinned = readFileSync(join(root, ".bun-version"), "utf8").trim();
		return pinned.replace(/^v/, "") || undefined;
	} catch {
		return undefined;
	}
}

/** The command that installs the pinned Bun. */
export function bunInstallCommand(pinned: string): string {
	return `curl -fsSL https://bun.sh/install | bash -s "bun-v${pinned}"`;
}
