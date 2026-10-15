import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cases from "./fixtures/repo-keys.json";
import { localRepoKey, repoKeyFromRemote, resolveRepoKey } from "./repo-key";

describe("repoKeyFromRemote", () => {
	for (const { remote, key } of cases)
		it(`${remote} → ${key ?? "no key"}`, () => {
			expect(repoKeyFromRemote(remote)).toBe(key ?? undefined);
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

	it("is undefined outside git", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-no-git-")));
		try {
			expect(resolveRepoKey(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
