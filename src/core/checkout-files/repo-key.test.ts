import { describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cases from "./fixtures/repo-keys.json";
import {
	localRepoKey,
	parseOrigin,
	repoKeyFromRemote,
	resolveRepoKey,
} from "./repo-key";

describe("repoKeyFromRemote", () => {
	for (const { remote, key } of cases)
		it(`${remote} → ${key ?? "no key"}`, () => {
			expect(repoKeyFromRemote(remote)).toBe(key ?? undefined);
		});
});

describe("parseOrigin", () => {
	it("reads the first url of the origin section", () => {
		const config = [
			"[core]",
			"\tbare = false",
			'[remote "upstream"]',
			"\turl = git@github.com:Other/App.git",
			'[REMOTE "origin"] # the fork',
			"\tfetch = +refs/heads/*:refs/remotes/origin/*",
			"\tURL = https://github.com/Acme/App.git",
			"\turl = git@github.com:Acme/Mirror.git",
		].join("\n");
		expect(parseOrigin(config)).toEqual({
			url: "https://github.com/Acme/App.git",
		});
	});

	it("says there is no origin when no section names it", () => {
		expect(parseOrigin('[remote "upstream"]\n\turl = a@b:c/d')).toBe("none");
	});

	for (const [shape, config] of [
		["a quoted value", '[remote "origin"]\n\turl = "git@github.com:a/b"'],
		["a trailing comment", '[remote "origin"]\n\turl = git@github.com:a/b # x'],
		["the dotted section form", "[remote.origin]\n\turl = git@github.com:a/b"],
		["a key on the header line", '[remote "origin"] url = git@github.com:a/b'],
		["an origin section with no url", '[remote "origin"]\n\tfetch = x'],
	] as const)
		it(`leaves ${shape} to git`, () => {
			expect(parseOrigin(config)).toBeUndefined();
		});
});

describe("resolveRepoKey", () => {
	function repo(): string {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-repo-key-")));
		spawnSync("git", ["init", "-q"], { cwd: dir });
		return dir;
	}

	it("uses origin", () => {
		const dir = repo();
		try {
			spawnSync(
				"git",
				["remote", "add", "origin", "git@github.com:Acme/App.git"],
				{ cwd: dir },
			);
			expect(resolveRepoKey(dir)).toBe("github.com/acme/app");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to the git common dir without origin", () => {
		const dir = repo();
		try {
			const key = resolveRepoKey(dir);
			expect(key).toBe(localRepoKey(join(dir, ".git")));
			expect(key).toMatch(/^local\/[0-9a-f]{16}$/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads origin from a worktree's main config without forking git", () => {
		const dir = repo();
		const worktree = `${dir}-worktree`;
		try {
			const run = (cwd: string, ...args: string[]) =>
				spawnSync(
					"git",
					["-c", "user.name=t", "-c", "user.email=t@t", ...args],
					{
						cwd,
					},
				);
			run(dir, "remote", "add", "origin", "https://github.com/Acme/App.git");
			run(dir, "commit", "-q", "--allow-empty", "-m", "init");
			run(dir, "worktree", "add", "-q", worktree);
			const spawns = spyOn(childProcess, "spawnSync");
			try {
				expect(resolveRepoKey(worktree)).toBe("github.com/acme/app");
				expect(resolveRepoKey(dir)).toBe("github.com/acme/app");
				expect(spawns).not.toHaveBeenCalled();
			} finally {
				spawns.mockRestore();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(worktree, { recursive: true, force: true });
		}
	});

	it("asks git when the config rewrites URLs", () => {
		const dir = repo();
		try {
			spawnSync("git", ["remote", "add", "origin", "gh:Acme/App.git"], {
				cwd: dir,
			});
			appendFileSync(
				join(dir, ".git", "config"),
				'[url "git@github.com:"]\n\tinsteadOf = gh:\n',
			);
			expect(resolveRepoKey(dir)).toBe("github.com/acme/app");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is undefined outside git", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-no-git-")));
		try {
			expect(resolveRepoKey(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
