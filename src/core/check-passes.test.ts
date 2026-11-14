import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	describePass,
	findReusedSummary,
	PASS_REUSE_MS,
	passKey,
	readPasses,
	recordPasses,
	reusablePass,
	reusedSummary,
	treeFingerprint,
} from "./check-passes";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
	const result = Bun.spawnSync(
		["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args],
		{ cwd: root },
	);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function tempDir(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-passes-")));
	roots.push(root);
	return root;
}

/** A repository with one commit: `a.ts` and a `.gitignore` for `ignored/`. */
function repo(): string {
	const root = tempDir();
	writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
	writeFileSync(join(root, ".gitignore"), "ignored/\n");
	git(root, "init", "-q");
	git(root, "add", ".");
	git(root, "commit", "-qm", "base");
	return root;
}

describe("treeFingerprint", () => {
	it("is the same before and after staging, which is what a pre-commit hook sees", () => {
		const root = repo();
		writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
		writeFileSync(join(root, "new.ts"), "export const b = 1;\n");
		const edited = treeFingerprint(root);

		git(root, "add", "-A");
		expect(treeFingerprint(root)).toBe(edited);
	});

	it("changes with a tracked edit, an untracked file, a deletion and a commit", () => {
		const root = repo();
		const seen = [treeFingerprint(root)];
		const next = () => {
			const tree = treeFingerprint(root);
			expect(tree).toBeDefined();
			expect(seen).not.toContain(tree);
			seen.push(tree);
		};

		writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
		next();
		writeFileSync(join(root, "new.ts"), "");
		next();
		symlinkSync("a.ts", join(root, "link.ts"));
		next();
		rmSync(join(root, "a.ts"));
		next();
		git(root, "add", "-A");
		git(root, "commit", "-qm", "second");
		next();
	});

	it("comes back when the content does", () => {
		const root = repo();
		const clean = treeFingerprint(root);
		writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
		expect(treeFingerprint(root)).not.toBe(clean);
		writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
		expect(treeFingerprint(root)).toBe(clean);
	});

	it("leaves out ignored files and buncargo's own state", () => {
		const root = repo();
		const clean = treeFingerprint(root);
		mkdirSync(join(root, "ignored"));
		writeFileSync(join(root, "ignored", "cache"), "x");
		// Not ignored by this repository: recording a pass must not change the
		// tree the pass stands for.
		mkdirSync(join(root, "apps", "web", ".buncargo"), { recursive: true });
		writeFileSync(join(root, "apps", "web", ".buncargo", "x.json"), "{}");
		expect(treeFingerprint(root)).toBe(clean);
	});

	it("covers the whole repository from a directory inside it", () => {
		const root = repo();
		mkdirSync(join(root, "apps", "web"), { recursive: true });
		writeFileSync(join(root, "apps", "web", "x.ts"), "");
		expect(treeFingerprint(join(root, "apps", "web"))).toBe(
			treeFingerprint(root),
		);
	});

	it("is undefined where nothing can be compared: no repository, no commit, a nested repository", () => {
		const plain = tempDir();
		expect(treeFingerprint(plain)).toBeUndefined();

		git(plain, "init", "-q");
		expect(treeFingerprint(plain)).toBeUndefined();

		const root = repo();
		mkdirSync(join(root, "vendor"));
		git(join(root, "vendor"), "init", "-q");
		writeFileSync(join(root, "vendor", "x.ts"), "");
		git(join(root, "vendor"), "add", ".");
		git(join(root, "vendor"), "commit", "-qm", "inner");
		expect(treeFingerprint(root)).toBeUndefined();
	});
});

describe("recorded passes", () => {
	const key = passKey(["sh", "-c", "bun run gen --check"], "apps/web");
	const at = 1_800_000_000_000;

	it("stand in for a run on the same tree, until they expire", async () => {
		const root = tempDir();
		await recordPasses(root, [key], { tree: "t1", at, by: "buncargo check" });
		const passes = await readPasses(root);

		expect(reusablePass(passes, key, "t1", at + 5_000)?.by).toBe(
			"buncargo check",
		);
		expect(reusablePass(passes, key, "t2", at + 5_000)).toBeUndefined();
		expect(reusablePass(passes, key, undefined, at + 5_000)).toBeUndefined();
		expect(reusablePass(passes, key, "t1", at + PASS_REUSE_MS)).toBeUndefined();
		// A clock that went backwards proves nothing about the pass.
		expect(reusablePass(passes, key, "t1", at - 1)).toBeUndefined();
	});

	it("are kept per command and working directory", async () => {
		const root = tempDir();
		await recordPasses(root, [key], { tree: "t1", at, by: "buncargo check" });
		const passes = await readPasses(root);
		const elsewhere = passKey(["sh", "-c", "bun run gen --check"], "apps/api");
		const other = passKey(["sh", "-c", "bun run gen"], "apps/web");

		expect(reusablePass(passes, elsewhere, "t1", at)).toBeUndefined();
		expect(reusablePass(passes, other, "t1", at)).toBeUndefined();
	});

	it("keep the latest pass of a command and drop the expired ones", async () => {
		const root = tempDir();
		const pass = { tree: "t1", by: "buncargo check" };
		await recordPasses(root, ["old"], { ...pass, at });
		await recordPasses(root, [key], { ...pass, at: at + 1_000 });
		await recordPasses(root, [key], {
			...pass,
			tree: "t2",
			at: at + PASS_REUSE_MS + 500,
		});

		expect(await readPasses(root)).toEqual({
			[key]: { tree: "t2", at: at + PASS_REUSE_MS + 500, by: "buncargo check" },
		});
	});

	it("read as none from a file that is not theirs", async () => {
		const root = tempDir();
		mkdirSync(join(root, ".buncargo"));
		writeFileSync(
			join(root, ".buncargo", "check-passes.json"),
			JSON.stringify({ version: 99, passes: { [key]: { tree: "t1" } } }),
		);
		expect(await readPasses(root)).toEqual({});
	});
});

describe("naming a reused pass", () => {
	const pass = { tree: "t1", at: 1_000_000, by: "buncargo check --staged" };

	it("says how long ago and in which run", () => {
		expect(describePass(pass, 1_014_400)).toBe(
			"passed 14s ago in `buncargo check --staged`",
		);
		expect(describePass(pass, 1_000_000 + 12 * 60_000)).toBe(
			"passed 12m ago in `buncargo check --staged`",
		);
	});

	it("is found again in the output of the command that printed it", () => {
		const newer = { ...pass, at: 1_010_000, by: "buncargo typecheck" };
		const summary = reusedSummary([newer, pass], 3, 1_014_000);
		expect(summary).toBe(
			"2 of 3 reused (passed 14s ago in `buncargo check --staged`)",
		);
		expect(
			findReusedSummary(
				`✅ apps/api completed\n\nAll passed (9 files), ${summary}\n`,
			),
		).toBe(summary);
		expect(reusedSummary([], 3, 1_014_000)).toBeUndefined();
		expect(findReusedSummary("All passed (9 files)")).toBeUndefined();
	});
});
