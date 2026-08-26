import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
