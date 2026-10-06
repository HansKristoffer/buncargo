import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GitCheckout, listGitCheckouts } from "./git-checkouts";
import { checkoutProjectNames } from "./ports";

function git(cwd: string, ...args: string[]) {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) throw new Error(result.stderr);
}

/** A repository `repo`, a worktree `kept`, and a worktree `renamed` whose directory is gone. */
function repository(base: string) {
	const repo = join(base, "repo");
	mkdirSync(join(repo, "apps", "web"), { recursive: true });
	git(repo, "init", "-q");
	git(
		repo,
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	);
	git(repo, "worktree", "add", "-q", join(base, "kept"), "-b", "kept");
	git(repo, "worktree", "add", "-q", join(base, "renamed"), "-b", "gone");
	rmSync(join(base, "renamed"), { recursive: true });
	return repo;
}

const byRoot = (checkouts: GitCheckout[]) =>
	checkouts.sort((a, b) => a.root.localeCompare(b.root));

describe("listGitCheckouts", () => {
	it("lists the main checkout and every worktree, deleted ones included", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-git-")));
		try {
			const repo = repository(base);
			expect(byRoot(listGitCheckouts(join(base, "kept")))).toEqual([
				{ root: join(base, "kept"), worktree: "kept", exists: true },
				{ root: join(base, "renamed"), worktree: "renamed", exists: false },
				{ root: repo, worktree: null, exists: true },
			]);
			expect(listGitCheckouts(repo)).toHaveLength(3);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	// buncargo reads a worktree's name from the root's own `.git` file, so a
	// root below the top level carries none in its project names.
	it("puts a root below the top level at the same depth in each checkout, with no worktree name", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-git-")));
		try {
			const repo = repository(base);
			mkdirSync(join(base, "kept", "apps", "web"), { recursive: true });
			const web = (top: string) => join(top, "apps", "web");
			expect(byRoot(listGitCheckouts(web(repo)))).toEqual([
				{ root: web(join(base, "kept")), worktree: null, exists: true },
				{ root: web(join(base, "renamed")), worktree: null, exists: false },
				{ root: web(repo), worktree: null, exists: true },
			]);
			for (const checkout of listGitCheckouts(web(repo)))
				if (checkout.exists)
					expect(
						checkoutProjectNames({ projectPrefix: "pp", root: checkout.root }),
					).toEqual(
						checkoutProjectNames({
							projectPrefix: "pp",
							root: checkout.root,
							worktree: checkout.worktree,
						}),
					);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("counts a checkout whose root directory is missing as there, not deleted", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-git-")));
		try {
			const repo = repository(base);
			const kept = listGitCheckouts(join(repo, "apps", "web")).find((c) =>
				c.root.startsWith(join(base, "kept")),
			);
			expect(kept?.exists).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("throws outside a repository rather than listing nothing", () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-nogit-"));
		try {
			expect(() => listGitCheckouts(dir)).toThrow(/git rev-parse/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
