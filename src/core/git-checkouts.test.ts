import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listGitCheckouts } from "./git-checkouts";

function git(cwd: string, ...args: string[]) {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) throw new Error(result.stderr);
}

describe("listGitCheckouts", () => {
	it("lists the main checkout and every worktree, deleted ones included, at the config's depth", () => {
		const base = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-git-")));
		const repo = join(base, "repo");
		try {
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
			mkdirSync(join(base, "kept", "apps", "web"), { recursive: true });

			const fromWorktree = listGitCheckouts(join(base, "kept", "apps", "web"));
			expect(fromWorktree.sort((a, b) => a.root.localeCompare(b.root))).toEqual(
				[
					{
						root: join(base, "kept", "apps", "web"),
						worktree: "kept",
						exists: true,
					},
					{
						root: join(base, "renamed", "apps", "web"),
						worktree: "renamed",
						exists: false,
					},
					{ root: join(repo, "apps", "web"), worktree: null, exists: true },
				],
			);
			expect(listGitCheckouts(join(repo, "apps", "web"))).toHaveLength(3);
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
