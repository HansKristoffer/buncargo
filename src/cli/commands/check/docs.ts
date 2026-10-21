import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CheckConfig, DocPathsCheckConfig } from "../../../types";

/**
 * `buncargo check docs`: relative Markdown links that point nowhere, a
 * documented command Bun silently ignores and, with `check.docs.paths`,
 * backticked repository paths that do not exist.
 */

// Bun parses `bun --cwd <dir> run <script>` as a run with no script: it prints
// its usage text and exits 0, so a documented check silently checks nothing.
// `bun run --cwd <dir> <script>` and `bun --cwd <dir> <script>` both work.
const BROKEN_COMMAND = /bun --cwd \S+ run /;

// External URLs, anchors and mail links are not files.
const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;
const EXTERNAL_TARGET = /^([a-z][a-z0-9+.-]*:|#)/i;

// `apps/api/src/index.ts` in backticks. Globs and placeholders (`apps/*`,
// `<feature>/`, `...`) are not paths.
const INLINE_CODE = /`([^`\s]+)`/g;
const PLACEHOLDER = /[*<>{}$]|\.\.\./;
// Module paths are often written without their extension.
const MODULE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".vue", "/index.ts"];

export interface DocProblem {
	file: string;
	line: number;
	message: string;
}

/** Every Markdown file git sees, tracked or new, relative to `root`. */
export function markdownFiles(root: string): string[] {
	const result = Bun.spawnSync(
		["git", "ls-files", "--cached", "--others", "--exclude-standard", "*.md"],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);
	return result.stdout.toString().split("\n").filter(Boolean);
}

/** A malformed escape (`%zz`) is a broken link, not a crash. */
function decodedPath(target: string): string | undefined {
	try {
		return decodeURIComponent(target);
	} catch {
		return undefined;
	}
}

/** The path check's settings from `check.docs`, or `false` when it is off. */
export function docPathsConfig(
	docs: CheckConfig["docs"],
): DocPathsCheckConfig | false {
	if (typeof docs !== "object" || !docs.paths) return false;
	return docs.paths === true ? {} : docs.paths;
}

/** The root's directories: a backticked path starting with one is checked. */
function topLevelDirectories(root: string): Set<string> {
	const entries = readdirSync(root, { withFileTypes: true });
	return new Set(
		entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
	);
}

/**
 * Whether `path` exists from the root or from any directory between the root
 * and the doc: a workspace readme names `src/index.ts` from its own folder.
 */
function repoPathExists(root: string, file: string, path: string): boolean {
	const baseDirs = ["."];
	for (let dir = dirname(file); dir !== "."; dir = dirname(dir))
		baseDirs.push(dir);

	return baseDirs.some((dir) =>
		MODULE_SUFFIXES.some((suffix) =>
			existsSync(resolve(root, dir, path + suffix)),
		),
	);
}

/** Gitignored outputs (`.env`, `test-results/`) are absent from a fresh clone. */
function isGitIgnored(root: string, path: string): boolean {
	const result = Bun.spawnSync(["git", "check-ignore", "-q", path], {
		cwd: root,
		stdout: "ignore",
		stderr: "ignore",
	});
	return result.exitCode === 0;
}

function isExempt(
	config: DocPathsCheckConfig,
	file: string,
	path: string,
): boolean {
	return (config.exempt ?? []).some(
		(exemption) =>
			new Bun.Glob(exemption.file).match(file) &&
			(exemption.path === undefined || exemption.path === path),
	);
}

/** Backticked paths on one line that start in a root directory and are missing. */
function missingPaths(
	root: string,
	file: string,
	text: string,
	directories: Set<string>,
	config: DocPathsCheckConfig,
): string[] {
	const missing: string[] = [];
	for (const [, code = ""] of text.matchAll(INLINE_CODE)) {
		// Drop a `:line` or `#anchor` suffix, then a directory's trailing slash,
		// which git still needs to match a `dir/` ignore pattern.
		const written = code.replace(/[#:].*$/, "");
		const path = written.replace(/\/$/, "");
		const firstSegment = path.split("/")[0] ?? "";

		const looksLikeRepoPath =
			path.includes("/") &&
			directories.has(firstSegment) &&
			!PLACEHOLDER.test(path);
		if (!looksLikeRepoPath) continue;
		if (repoPathExists(root, file, path) || isExempt(config, file, path))
			continue;
		if (isGitIgnored(root, written)) continue;

		missing.push(path);
	}
	return missing;
}

export function findDocProblems(
	root: string,
	files: readonly string[],
	paths: DocPathsCheckConfig | false,
): DocProblem[] {
	const problems: DocProblem[] = [];
	const directories = paths ? topLevelDirectories(root) : new Set<string>();

	for (const file of files) {
		const path = join(root, file);
		// Listed by the index but deleted or moved in the working tree.
		if (!existsSync(path)) continue;

		let inCodeFence = false;
		readFileSync(path, "utf8")
			.split("\n")
			.forEach((text, index) => {
				const line = index + 1;
				if (BROKEN_COMMAND.test(text))
					problems.push({
						file,
						line,
						message: "use `bun run --cwd <dir> <script>`",
					});

				if (text.trimStart().startsWith("```")) inCodeFence = !inCodeFence;
				if (inCodeFence) return;

				if (paths)
					for (const missing of missingPaths(
						root,
						file,
						text,
						directories,
						paths,
					))
						problems.push({
							file,
							line,
							message: `\`${missing}\` does not exist`,
						});

				for (const [, target = ""] of text.matchAll(MARKDOWN_LINK)) {
					// `{{...}}` is a template placeholder filled in when the doc is rendered.
					if (EXTERNAL_TARGET.test(target) || target.includes("{{")) continue;
					const linked = decodedPath(target.split("#")[0] ?? "");
					if (linked && existsSync(resolve(dirname(path), linked))) continue;
					problems.push({ file, line, message: `broken link to ${target}` });
				}
			});
	}
	return problems;
}

export function formatDocProblem(problem: DocProblem): string {
	return `${problem.file}:${problem.line}: ${problem.message}`;
}
