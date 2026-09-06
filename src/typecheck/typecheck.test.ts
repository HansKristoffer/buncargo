import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runWorkspaceTypecheck } from "./typecheck";

/**
 * Fixtures live inside the repo so `bun run typecheck` resolves the local Bun
 * the same way a real consumer workspace would.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");
const created: string[] = [];

function makeFixture(): string {
	const dir = mkdtempSync(join(REPO_ROOT, ".typecheck-pool-test-"));
	created.push(dir);
	return dir;
}

function writeSleepingWorkspace(
	root: string,
	relative: string,
	sleepMs: number,
): void {
	const dir = join(root, relative);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify(
			{
				name: relative.replaceAll("/", "-"),
				scripts: {
					typecheck: `bun -e "await Bun.sleep(${sleepMs})"`,
				},
			},
			null,
			"\t",
		)}\n`,
	);
}

afterEach(() => {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("runWorkspaceTypecheck pool", () => {
	it("overlaps workspaces when concurrency is 2", async () => {
		const root = makeFixture();
		writeSleepingWorkspace(root, "apps/one", 200);
		writeSleepingWorkspace(root, "apps/two", 200);

		const overlapping = await runWorkspaceTypecheck({
			root,
			verbose: false,
			includeRootConfig: false,
			concurrency: 2,
		});
		expect(overlapping.success).toBe(true);
		expect(overlapping.workspaceCount).toBe(2);
		expect(overlapping.totalDuration).toBeLessThan(0.38);

		const serial = await runWorkspaceTypecheck({
			root,
			verbose: false,
			includeRootConfig: false,
			concurrency: 1,
		});
		expect(serial.success).toBe(true);
		expect(serial.totalDuration).toBeGreaterThan(0.35);
	});

	it("fails loudly when --only names an unknown workspace", async () => {
		const root = makeFixture();
		writeSleepingWorkspace(root, "apps/platform", 10);

		const result = await runWorkspaceTypecheck({
			root,
			verbose: false,
			includeRootConfig: false,
			only: ["mobile"],
		});

		expect(result.success).toBe(false);
		expect(result.selectionError).toContain("mobile");
		expect(result.selectionError).toContain("apps/platform");
	});
	it("discovers declared workspaces and preserves warm file totals", async () => {
		const root = makeFixture();
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				workspaces: { packages: ["components/*", "!components/skip"] },
			}),
		);
		writeSleepingWorkspace(root, "components/one", 0);
		writeSleepingWorkspace(root, "components/skip", 0);
		writeFileSync(join(root, "components/one/index.ts"), "export {};");
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await runWorkspaceTypecheck({
				root,
				includeRootConfig: false,
				verbose: false,
			});
			expect(result.workspaceCount).toBe(1);
			expect(result.totalFiles).toBe(1);
		}
	});

	it.each([0, -1, 1.5, Infinity, NaN])(
		"rejects invalid library concurrency %s",
		async (concurrency) => {
			await expect(
				runWorkspaceTypecheck({
					root: makeFixture(),
					concurrency,
					verbose: false,
				}),
			).rejects.toThrow("positive integer");
		},
	);

	it("includes root compiler execution in the concurrency budget", async () => {
		const root = makeFixture();
		writeSleepingWorkspace(root, "apps/one", 0);
		const eventFile = join(root, "events.jsonl");
		const compilerDir = join(root, "node_modules/typescript/bin");
		mkdirSync(compilerDir, { recursive: true });
		writeFileSync(join(root, "dev.config.ts"), "export default {};");
		const script = (name: string) =>
			`import { appendFileSync } from "node:fs"; const file = ${JSON.stringify(eventFile)}; appendFileSync(file, ${JSON.stringify(`${name}-start\n`)}); await Bun.sleep(100); appendFileSync(file, ${JSON.stringify(`${name}-end\n`)});`;
		writeFileSync(join(compilerDir, "tsc"), script("root"));
		writeFileSync(join(root, "apps/one/check.ts"), script("workspace"));
		writeFileSync(
			join(root, "apps/one/package.json"),
			JSON.stringify({ scripts: { typecheck: "bun check.ts" } }),
		);
		const result = await runWorkspaceTypecheck({
			root,
			concurrency: 1,
			verbose: false,
		});
		expect(result.success).toBe(true);
		expect(readFileSync(eventFile, "utf8").trim().split("\n")).toEqual([
			"root-start",
			"root-end",
			"workspace-start",
			"workspace-end",
		]);
	});
});
