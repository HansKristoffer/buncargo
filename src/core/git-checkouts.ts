import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";

/** A checkout Git knows of, whether or not its directory still exists. */
export interface GitCheckout {
	/** The checkout's buncargo root: the same directory inside this checkout. */
	root: string;
	/**
	 * The worktree name buncargo puts in this checkout's project names: its
	 * name under `.git/worktrees`, but only when the root is the worktree's
	 * top level, since buncargo reads it from the root's own `.git` file.
	 * Null for the main checkout and for a root below the top level.
	 */
	worktree: string | null;
	/** Whether the checkout is still there (its top level, not the root). */
	exists: boolean;
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.error || result.status !== 0)
		throw new Error(
			`git ${args.join(" ")} failed in ${cwd}: ${(result.stderr || result.error?.message || "").trim()}`,
		);
	return result.stdout.trim();
}

/**
 * Every checkout of the repository `root` is in: the main one, and each
 * worktree in Git's metadata, including deleted ones Git has not pruned yet
 * (their `gitdir` file outlives the directory).
 *
 * `root` may sit below the repository's top level; each checkout's root is
 * the same path inside that checkout. Throws when Git cannot answer, so a
 * caller deciding what is disposable never decides from an empty list.
 */
export function listGitCheckouts(root: string): GitCheckout[] {
	const top = git(root, ["rev-parse", "--show-toplevel"]);
	const inside = relative(realpathSync(top), realpathSync(root));
	const commonDir = resolve(root, git(root, ["rev-parse", "--git-common-dir"]));
	const at = (checkoutTop: string, worktree: string | null): GitCheckout => {
		const checkoutRoot = join(checkoutTop, inside);
		// Real, as the loader records a root in its labels and lock names.
		return {
			root: existsSync(checkoutRoot)
				? realpathSync(checkoutRoot)
				: checkoutRoot,
			worktree: inside === "" ? worktree : null,
			exists: existsSync(checkoutTop),
		};
	};

	// A bare repository has no main checkout, only worktrees.
	const checkouts =
		basename(commonDir) === ".git" ? [at(dirname(commonDir), null)] : [];
	const admin = join(commonDir, "worktrees");
	if (!existsSync(admin)) return checkouts;
	for (const name of readdirSync(admin)) {
		const gitdirFile = join(admin, name, "gitdir");
		if (!existsSync(gitdirFile)) continue;
		// `gitdir` names the checkout's `.git` file.
		const gitdir = readFileSync(gitdirFile, "utf-8").trim();
		checkouts.push(
			at(
				dirname(isAbsolute(gitdir) ? gitdir : resolve(admin, name, gitdir)),
				name,
			),
		);
	}
	return checkouts;
}
