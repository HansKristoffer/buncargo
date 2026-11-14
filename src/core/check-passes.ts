import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { isString } from "hanzio";
import { withFileLock } from "./file-lock";
import {
	type Guarded,
	isFiniteNumber,
	object,
	recordOf,
	refine,
} from "./json-shape";
import { readJsonDocument, writeJsonDocument } from "./registry-file";
import { projectStateFilePath, STATE_DIRNAME } from "./state-paths";
import { buncargoVersion } from "./version";

/**
 * Passes of `buncargo check` steps and `buncargo typecheck` jobs, kept per
 * checkout so the next run can skip what already passed on the same tree.
 *
 * One change used to pay for the same typecheck three times: a typecheck on
 * its own, then `check`, then the pre-commit hook's `check --staged` seconds
 * later. A pass is reused only when the same command would read the same
 * files: the key is the command and where it runs, the tree is every tracked
 * and untracked file of the working tree. Ignored files are not part of it
 * (`node_modules` follows `bun.lock`, which is), so a pass also expires.
 */

/** How long a pass stands in for a run. Ignored files can change unseen. */
export const PASS_REUSE_MS = 30 * 60_000;

/** Above this a file counts by size and modification time, not content. */
const HASHED_FILE_MAX_BYTES = 16 * 1024 * 1024;

const PASSES_VERSION = 1;
const PASSES_FILE = "check-passes.json";

const isRecordedPass = object({
	/** The working tree it passed on ({@link treeFingerprint}). */
	tree: isString,
	/** When it passed, in epoch milliseconds. */
	at: isFiniteNumber,
	/** The command that ran it: `buncargo check --staged`. */
	by: isString,
});
export type RecordedPass = Guarded<typeof isRecordedPass>;

const isPassesFile = object({
	version: refine(isFiniteNumber, (version) => version === PASSES_VERSION),
	passes: recordOf(isRecordedPass),
});

/** The latest pass of each command, by {@link passKey}. */
export type RecordedPasses = Readonly<Record<string, RecordedPass>>;

function git(root: string, args: string[]): string | undefined {
	// --no-optional-locks: a pre-commit hook runs this while git holds the index.
	const result = Bun.spawnSync(["git", "--no-optional-locks", ...args], {
		cwd: root,
		stdout: "pipe",
		stderr: "ignore",
	});
	return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

/** What a changed path holds now, or undefined when that cannot be told. */
function pathContent(path: string): string | undefined {
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(path);
	} catch {
		return "gone";
	}
	if (stats.isSymbolicLink()) return `link:${readlinkSync(path)}`;
	// A submodule or a nested repository: git names it, not what is inside.
	if (!stats.isFile()) return undefined;
	if (stats.size > HASHED_FILE_MAX_BYTES)
		return `big:${stats.size}:${stats.mtimeMs}`;
	return Bun.hash(readFileSync(path)).toString(36);
}

/**
 * The working tree of the repository holding `root`, as one hash: the commit's
 * tree and the content of every path that differs from it, untracked files
 * included. Staging changes nothing, so a tree checked before `git add` is the
 * tree its pre-commit hook sees. Undefined when it cannot be told (no git, no
 * commit yet, a changed submodule): nothing is reused then.
 */
export function treeFingerprint(root: string): string | undefined {
	const [top, headTree] =
		git(root, ["rev-parse", "--show-toplevel", "HEAD^{tree}"])?.split("\n") ??
		[];
	if (!top || !headTree) return undefined;
	const status = git(top, [
		"status",
		"--porcelain=v1",
		"-z",
		"--no-renames",
		"--untracked-files=all",
	]);
	if (status === undefined) return undefined;

	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(headTree);
	// Each entry is `XY <path>`; the two status letters are how far the change
	// is staged, which the files on disk do not depend on.
	// buncargo's own state is not the project's: a checkout that does not
	// ignore `.buncargo/` would otherwise change its tree by recording a pass.
	const paths = status
		.split("\0")
		.filter(Boolean)
		.map((entry) => entry.slice(3))
		.filter((path) => !path.split("/").includes(STATE_DIRNAME));
	for (const path of [...new Set(paths)].sort()) {
		const content = pathContent(join(top, path));
		if (content === undefined) return undefined;
		hasher.update(`\0${path}\0${content}`);
	}
	return hasher.digest("hex");
}

/**
 * What identifies a command for reuse: its words, where it runs, and the Bun
 * and buncargo that run it. `cwd` is relative to the checkout's root.
 */
export function passKey(command: readonly string[], cwd = "."): string {
	return JSON.stringify([Bun.version, buncargoVersion() ?? "", cwd, command]);
}

export async function readPasses(root: string): Promise<RecordedPasses> {
	const file = await readJsonDocument(
		projectStateFilePath(root, PASSES_FILE),
		(value) => (isPassesFile(value) ? value : undefined),
	);
	return file?.passes ?? {};
}

/** The pass that stands in for running `key` on `tree` now, when there is one. */
export function reusablePass(
	passes: RecordedPasses,
	key: string,
	tree: string | undefined,
	now: number,
): RecordedPass | undefined {
	const pass = passes[key];
	if (!pass || tree === undefined || pass.tree !== tree) return undefined;
	const age = now - pass.at;
	return age >= 0 && age < PASS_REUSE_MS ? pass : undefined;
}

/** Record that every command in `keys` passed; expired passes are dropped. */
export async function recordPasses(
	root: string,
	keys: readonly string[],
	pass: RecordedPass,
): Promise<void> {
	if (keys.length === 0) return;
	const path = projectStateFilePath(root, PASSES_FILE);
	await withFileLock(path, async () => {
		const passes: Record<string, RecordedPass> = {};
		for (const [key, recorded] of Object.entries(await readPasses(root)))
			if (pass.at - recorded.at < PASS_REUSE_MS) passes[key] = recorded;
		for (const key of keys) passes[key] = pass;
		await writeJsonDocument(path, { version: PASSES_VERSION, passes });
	});
}

function ago(milliseconds: number): string {
	const seconds = Math.max(0, Math.round(milliseconds / 1000));
	return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

/** `passed 14s ago in `buncargo check``: the run a reused pass came from. */
export function describePass(pass: RecordedPass, now: number): string {
	return `passed ${ago(now - pass.at)} in \`${pass.by}\``;
}

/** What a later run calls this one, from its arguments: `buncargo check --staged`. */
export function runName(args: readonly string[]): string {
	return ["buncargo", ...args].join(" ");
}

const REUSED_SUMMARY = /\d+ of \d+ reused \(passed [^)]*\)/;

/**
 * `2 of 3 reused (passed 14s ago in `buncargo check`)`: how a command that
 * reuses passes of its own (the typecheck, per workspace) says so in its
 * output. `check` runs it as one step and shows this part of its last line.
 */
export function reusedSummary(
	reused: readonly RecordedPass[],
	total: number,
	now: number,
): string | undefined {
	const oldest = reused.toSorted((a, b) => a.at - b.at)[0];
	if (!oldest) return undefined;
	return `${reused.length} of ${total} reused (${describePass(oldest, now)})`;
}

/** The {@link reusedSummary} in a command's output, when it printed one. */
export function findReusedSummary(output: string): string | undefined {
	return output.match(REUSED_SUMMARY)?.[0];
}
