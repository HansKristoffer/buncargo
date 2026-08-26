import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { typecheckRootConfig } from "./config-typecheck";

/**
 * Fixtures live inside the repo, not the OS temp dir: `typecheckRootConfig`
 * shells out to `bunx tsc` with the fixture as cwd, and only a directory under
 * the repo resolves the local TypeScript by walking up to `node_modules`.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");

const created: string[] = [];

function makeFixture(): string {
	const dir = mkdtempSync(join(REPO_ROOT, ".config-typecheck-test-"));
	created.push(dir);
	return dir;
}

afterEach(() => {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("typecheckRootConfig", () => {
	it("passes with no config file, so callers can run it unconditionally", async () => {
		const result = await typecheckRootConfig({
			root: makeFixture(),
			verbose: false,
		});

		expect(result.configFile).toBeNull();
		expect(result.success).toBe(true);
	});

	it("accepts a config that typechecks", async () => {
		const root = makeFixture();
		writeFileSync(
			join(root, "dev.config.ts"),
			"export default { projectPrefix: 'ok' }\n",
		);

		const result = await typecheckRootConfig({ root, verbose: false });

		expect(result.configFile).toBe("dev.config.ts");
		expect(result.success).toBe(true);
	});

	it("accepts a config that reads process.env", async () => {
		const root = makeFixture();
		writeFileSync(
			join(root, "dev.config.ts"),
			"export default { projectPrefix: process.env.BUNCARGO_PROJECT_PREFIX ?? 'ok' }\n",
		);

		const result = await typecheckRootConfig({ root, verbose: false });

		expect(result.success).toBe(true);
	});

	it("reports the error for a config that does not typecheck", async () => {
		const root = makeFixture();
		writeFileSync(
			join(root, "dev.config.ts"),
			"const port: number = 'not a number'\nexport default { port }\n",
		);

		const result = await typecheckRootConfig({ root, verbose: false });

		expect(result.success).toBe(false);
		expect(result.errorOutput).toContain("dev.config.ts");
	});

	it("finds the alternate config filenames", async () => {
		const root = makeFixture();
		writeFileSync(
			join(root, "dev-tools.config.ts"),
			"export default { projectPrefix: 'alt' }\n",
		);

		const result = await typecheckRootConfig({ root, verbose: false });

		expect(result.configFile).toBe("dev-tools.config.ts");
		expect(result.success).toBe(true);
	});
});
