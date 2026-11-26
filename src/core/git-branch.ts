import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The current Git branch of a checkout (walking up to the nearest `.git`
 * directory or worktree pointer file), or `undefined` on detached HEAD,
 * non-git directories, or unreadable metadata.
 *
 * Kept as a tiny filesystem-only leaf so `buncargo` config helpers
 * (`lookupRunningApp`) and `run-publish.ts` can read it without pulling in
 * process supervision or runtime modules.
 */
export function readGitBranch(root: string): string | undefined {
	try {
		let dir = resolve(root);
		let gitPath: string | undefined;
		for (;;) {
			const candidate = join(dir, ".git");
			if (existsSync(candidate)) {
				gitPath = candidate;
				break;
			}
			const parent = dirname(dir);
			if (parent === dir) return undefined;
			dir = parent;
		}

		const gitFileText = statSync(gitPath).isFile()
			? readFileSync(gitPath, "utf-8")
			: "";
		const gitDir = gitFileText.startsWith("gitdir:")
			? resolve(dirname(gitPath), gitFileText.slice("gitdir:".length).trim())
			: gitPath;
		const head = readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
		const match = head.match(/^ref:\s*refs\/heads\/(.+)$/);
		return match?.[1];
	} catch {
		return undefined;
	}
}
