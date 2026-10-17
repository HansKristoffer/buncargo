import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reading and extending a checkout's `.gitignore`: what `doctor` and `setup`
 * check and fix for the files buncargo and its integrations write.
 */

/** Whether `.gitignore` names a path, the way a person would write it. */
export function gitignoreCovers(root: string, path: string): boolean {
	try {
		const bare = path.replace(/^\/+|\/+$/g, "");
		return readFileSync(join(root, ".gitignore"), "utf8")
			.split("\n")
			.map((line) => line.trim().replace(/^\/+|\/+$/g, ""))
			.some((line) => line === bare || line === `${bare}/**`);
	} catch {
		return false;
	}
}

/**
 * Whether git ignores a path; outside a git checkout nothing is. Asks git
 * rather than reading `.gitignore`: patterns, nested ignore files and
 * negations all count, and only git knows them.
 */
export function isGitIgnored(root: string, path: string): boolean {
	const result = Bun.spawnSync(["git", "check-ignore", "-q", path], {
		cwd: root,
		stdout: "ignore",
		stderr: "ignore",
	});
	return result.exitCode === 0;
}

/** Append lines to `.gitignore`, creating it when missing. */
export function appendToGitignore(
	root: string,
	lines: readonly string[],
): void {
	const path = join(root, ".gitignore");
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	const prefix = current && !current.endsWith("\n") ? "\n" : "";
	writeFileSync(path, `${current}${prefix}${lines.join("\n")}\n`);
}
