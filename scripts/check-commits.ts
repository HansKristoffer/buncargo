/**
 * Check that every commit since `<base>` passes `bun run lint` on its own, as
 * one-logical-change-per-commit promises.
 *
 *   bun scripts/check-commits.ts <base> [--test]
 *
 * Each commit is checked out in one temporary worktree, so the working tree
 * here is never touched. It links this checkout's `node_modules` rather than
 * installing per commit, so a commit that changes dependencies is checked
 * against the ones installed here. `--test` also runs `bun test` on each
 * commit, which takes minutes per commit.
 */
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function git(args: string[], cwd = ROOT): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
	if (result.exitCode !== 0)
		throw new Error(
			`git ${args.join(" ")}: ${result.stderr.toString().trim()}`,
		);
	return result.stdout.toString().trim();
}

/** Run `command` in `cwd`, keeping its output to show only when it fails. */
function passes(
	command: string[],
	cwd: string,
): { ok: boolean; output: string } {
	const result = Bun.spawnSync(command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${result.stdout.toString()}${result.stderr.toString()}`;
	return { ok: result.exitCode === 0, output };
}

const args = process.argv.slice(2);
const base = args.find((arg) => !arg.startsWith("--"));
const withTests = args.includes("--test");
if (!base) {
	console.error("Usage: bun scripts/check-commits.ts <base> [--test]");
	process.exit(2);
}

const commits = git(["rev-list", "--reverse", `${base}..HEAD`])
	.split("\n")
	.filter(Boolean);
if (commits.length === 0) {
	console.log(`No commits after ${base}.`);
	process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "buncargo-check-"));
const worktree = join(scratch, "tree");

let failed = 0;
try {
	git(["worktree", "add", "--quiet", "--detach", worktree, commits[0]]);
	symlinkSync(join(ROOT, "node_modules"), join(worktree, "node_modules"));

	for (const commit of commits) {
		git(["checkout", "--quiet", "--detach", commit], worktree);
		const title = git(["log", "-1", "--format=%h %s", commit]);

		const checks = [["bun", "run", "lint"]];
		if (withTests) checks.push(["bun", "test"]);
		const failure = checks
			.map((command) => ({ command, ...passes(command, worktree) }))
			.find((check) => !check.ok);

		if (!failure) {
			console.log(`ok    ${title}`);
			continue;
		}
		failed += 1;
		console.log(`FAIL  ${title}  (${failure.command.join(" ")})`);
		console.log(failure.output.trimEnd().replace(/^/gm, "      "));
	}
} finally {
	if (existsSync(worktree)) git(["worktree", "remove", "--force", worktree]);
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${commits.length - failed}/${commits.length} commits pass.`);
process.exit(failed > 0 ? 1 : 0);
