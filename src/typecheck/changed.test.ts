import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	changedFilesSince,
	selectChangedWorkspaces,
	type WorkspaceNode,
} from "./changed";

// prisma <- utils <- backend <- platform, plus an unrelated marketing site.
const graph: WorkspaceNode[] = [
	{ path: "packages/prisma", name: "@x/prisma", dependencies: [] },
	{ path: "packages/utils", name: "@x/utils", dependencies: ["@x/prisma"] },
	{ path: "packages/tsconfig", name: "@x/tsconfig", dependencies: [] },
	{
		path: "apps/backend",
		name: "@x/backend",
		dependencies: ["@x/utils", "@x/tsconfig", "zod"],
	},
	{ path: "apps/platform", name: "@x/platform", dependencies: ["@x/backend"] },
	{ path: "apps/marketing", name: "@x/marketing", dependencies: [] },
];
// packages/tsconfig has no typecheck script, so it is never checked itself.
const checkable = graph
	.map((node) => node.path)
	.filter((path) => path !== "packages/tsconfig");

function select(files: string[], paths = checkable) {
	return selectChangedWorkspaces(files, graph, paths);
}

describe("selectChangedWorkspaces", () => {
	it("checks a changed workspace and everything that depends on it", () => {
		expect(select(["packages/utils/src/date.ts"])).toEqual({
			kind: "workspaces",
			paths: ["packages/utils", "apps/backend", "apps/platform"],
		});
	});

	it("checks a leaf app alone", () => {
		expect(select(["apps/platform/src/App.vue"])).toEqual({
			kind: "workspaces",
			paths: ["apps/platform"],
		});
	});

	it("follows dependents through a package that has nothing to check", () => {
		expect(select(["packages/tsconfig/base.json"])).toEqual({
			kind: "workspaces",
			paths: ["apps/backend", "apps/platform"],
		});
	});

	it("checks everything when a root manifest, lockfile, tsconfig or the dev config changed", () => {
		for (const file of [
			"bun.lock",
			"package.json",
			"tsconfig.base.json",
			"dev.config.ts",
		])
			expect(select([file])).toEqual({ kind: "all" });
	});

	it("checks nothing for root files that shape no program", () => {
		expect(select(["README.md", "scripts/notes.txt"])).toEqual({
			kind: "workspaces",
			paths: [],
		});
	});

	it("treats a workspace's own package.json as that workspace", () => {
		expect(select(["apps/marketing/package.json"])).toEqual({
			kind: "workspaces",
			paths: ["apps/marketing"],
		});
	});

	it("still sees a root-wide file when the root itself is an included directory", () => {
		expect(select(["bun.lock"], [...checkable, "."])).toEqual({ kind: "all" });
		expect(select(["scripts/build.ts"], [...checkable, "."])).toEqual({
			kind: "workspaces",
			paths: ["."],
		});
	});
});

describe("changedFilesSince", () => {
	const repos: string[] = [];
	afterEach(() => {
		for (const dir of repos.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	function git(cwd: string, ...args: string[]) {
		const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	}

	function write(root: string, file: string, content = "x") {
		mkdirSync(join(root, file, ".."), { recursive: true });
		writeFileSync(join(root, file), content);
	}

	it("lists committed, uncommitted, untracked and deleted files since the merge base", () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo-changed-"));
		repos.push(root);
		git(root, "init", "-q", "-b", "main");
		git(root, "config", "user.email", "test@example.com");
		git(root, "config", "user.name", "test");
		write(root, "apps/a/kept.ts");
		write(root, "apps/a/removed.ts");
		write(root, "apps/b/edited.ts");
		git(root, "add", ".");
		git(root, "commit", "-q", "-m", "base");

		git(root, "checkout", "-q", "-b", "feature");
		write(root, "packages/c/committed.ts");
		git(root, "add", ".");
		git(root, "commit", "-q", "-m", "work");
		write(root, "apps/b/edited.ts", "y");
		rmSync(join(root, "apps/a/removed.ts"));
		write(root, "apps/d/untracked.ts");

		expect(changedFilesSince(root).sort()).toEqual([
			"apps/a/removed.ts",
			"apps/b/edited.ts",
			"apps/d/untracked.ts",
			"packages/c/committed.ts",
		]);
		expect(() => changedFilesSince(root, "no-such-ref")).toThrow(
			'no merge base between HEAD and "no-such-ref"',
		);
	});
});
