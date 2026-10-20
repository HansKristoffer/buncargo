import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDocProblems, formatDocProblem } from "./docs";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function docs(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "buncargo-docs-"));
	roots.push(root);
	mkdirSync(join(root, "docs"));
	for (const [file, text] of Object.entries(files))
		writeFileSync(join(root, file), text);
	return root;
}

describe("docs check", () => {
	it("reports links to missing files, relative to the linking doc", () => {
		const root = docs({
			"readme.md": [
				"[ok](docs/guide.md) [anchor](docs/guide.md#setup)",
				"[gone](docs/missing.md) [web](https://example.com) [top](#top)",
				"[template]({{url}}) [mail](mailto:a@b.c) [bad](%zz)",
			].join("\n"),
			"docs/guide.md": "[up](../readme.md) [space](my%20file.md)",
			"docs/my file.md": "",
		});
		expect(
			findDocProblems(root, ["readme.md", "docs/guide.md"]).map(
				formatDocProblem,
			),
		).toEqual([
			"readme.md:2: broken link to docs/missing.md",
			"readme.md:3: broken link to %zz",
		]);
	});

	it("skips code fences and files that are gone, and flags a no-op bun command", () => {
		const root = docs({
			"a.md": [
				"```",
				"[inside](nowhere.md)",
				"```",
				"Run `bun --cwd apps/web run build`.",
			].join("\n"),
		});
		expect(
			findDocProblems(root, ["a.md", "deleted.md"]).map(formatDocProblem),
		).toEqual(["a.md:4: use `bun run --cwd <dir> <script>`"]);
	});
});
