import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * `buncargo check docs`: relative Markdown links that point nowhere, and a
 * documented command Bun silently ignores.
 */

// Bun parses `bun --cwd <dir> run <script>` as a run with no script: it prints
// its usage text and exits 0, so a documented check silently checks nothing.
// `bun run --cwd <dir> <script>` and `bun --cwd <dir> <script>` both work.
const BROKEN_COMMAND = /bun --cwd \S+ run /;

// External URLs, anchors and mail links are not files.
const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;
const EXTERNAL_TARGET = /^([a-z][a-z0-9+.-]*:|#)/i;

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

export function findDocProblems(
	root: string,
	files: readonly string[],
): DocProblem[] {
	const problems: DocProblem[] = [];
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
