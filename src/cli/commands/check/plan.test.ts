import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { selectGates, testsFor, touches } from "./plan";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function tree(files: string[]) {
	const root = mkdtempSync(join(tmpdir(), "buncargo-check-"));
	roots.push(root);
	for (const file of files) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), "");
	}
	return root;
}

const gates = [
	{ name: "i18n", command: "x", when: ["**/locales/**"] },
	{ name: "web", command: "x", when: ["apps/web/**", "packages/**"] },
	{ name: "codegen", command: "x", staged: false },
];

describe("check gates", () => {
	it("selects a gate when a changed file matches its globs", () => {
		expect(
			selectGates(gates, ["apps/web/src/a.ts"], "changed").map((g) => g.name),
		).toEqual(["web", "codegen"]);
		expect(
			selectGates(gates, ["apps/api/locales/en.json"], "changed").map(
				(g) => g.name,
			),
		).toEqual(["i18n", "codegen"]);
	});

	it("treats a root manifest or the dev config as touching every gate", () => {
		for (const file of ["package.json", "bun.lock", "dev.config.ts"])
			expect(selectGates(gates, [file], "changed")).toHaveLength(3);
	});

	it("leaves non-staged gates out of --staged and runs everything in --all", () => {
		expect(
			selectGates(gates, ["package.json"], "staged").map((g) => g.name),
		).toEqual(["i18n", "web"]);
		expect(selectGates(gates, [], "all")).toHaveLength(3);
	});

	it("matches Markdown at any depth", () => {
		expect(touches(["readme.md"], ["**/*.md", "*.md"], "changed")).toBe(true);
		expect(touches(["docs/a/b.md"], ["**/*.md"], "changed")).toBe(true);
		expect(touches(["src/a.ts"], ["**/*.md"], "changed")).toBe(false);
	});
});

describe("tests next to changed files", () => {
	it("finds a changed test and the tests beside a changed source", async () => {
		const root = tree([
			"src/a.ts",
			"src/a.test.ts",
			"src/a.database.test.ts",
			"src/ab.test.ts",
			"src/b.test.tsx",
			"e2e/flow.test.ts",
		]);
		expect(
			await testsFor(root, ["src/a.ts", "src/b.test.tsx", "readme.md"]),
		).toEqual(["src/a.database.test.ts", "src/a.test.ts", "src/b.test.tsx"]);
	});

	it("drops deleted and excluded tests", async () => {
		const root = tree(["e2e/flow.test.ts", "e2e/flow.ts"]);
		expect(
			await testsFor(root, ["gone.test.ts", "e2e/flow.ts"], ["e2e/**"]),
		).toEqual([]);
	});
});
