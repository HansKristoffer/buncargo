/**
 * When a buncargo command last ran in a checkout: the command half of a
 * detached run's idle limit (`run-limits.ts`; the request half is
 * `hosts/proxy-activity.ts`).
 *
 * Paid by every command, so it is the mtime of one file in the checkout's
 * `.buncargo/`, set with `utimes`: no fork, no lock, no JSON. A directory
 * without `.buncargo/` has never had a run, so nothing is created there.
 */

import { existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { findMonorepoRoot } from "./ports";
import { getProjectStateDir, projectStateFilePath } from "./state-paths";

const COMMAND_FILE = "last-command";

/** Mark that a buncargo command ran in the checkout around `cwd`. Never throws. */
export function noteCheckoutCommand(cwd = process.cwd()): void {
	try {
		const root = findMonorepoRoot(cwd);
		const file = projectStateFilePath(root, COMMAND_FILE);
		const now = new Date();
		try {
			utimesSync(file, now, now);
		} catch {
			if (existsSync(getProjectStateDir(root))) writeFileSync(file, "");
		}
	} catch {
		// A command that cannot mark the checkout still runs.
	}
}

/** When a buncargo command last ran in `root` (epoch ms), if one ever did. */
export function lastCheckoutCommandAt(root: string): number | undefined {
	try {
		return statSync(projectStateFilePath(root, COMMAND_FILE)).mtimeMs;
	} catch {
		return undefined;
	}
}
