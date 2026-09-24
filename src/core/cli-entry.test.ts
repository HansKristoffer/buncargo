import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buncargoCli, findCliEntry } from "./cli-entry";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

/** A package directory with a `package.json` and the given files. */
function fakePackage(files: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "buncargo-cli-entry-"));
	roots.push(root);
	writeFileSync(join(root, "package.json"), "{}");
	for (const file of files) {
		mkdirSync(join(root, file, ".."), { recursive: true });
		writeFileSync(join(root, file), "");
	}
	return root;
}

describe("findCliEntry", () => {
	it("calls back into the build when running from the build, even from a chunk", () => {
		const root = fakePackage(["dist/cli/bin.js", "src/cli/bin.ts"]);
		// `--splitting` puts shared code in chunks at the root of `dist`.
		expect(findCliEntry(join(root, "dist"))).toBe(
			join(root, "dist/cli/bin.js"),
		);
		expect(findCliEntry(join(root, "dist/core"))).toBe(
			join(root, "dist/cli/bin.js"),
		);
	});

	it("calls back into source when running from source, even if a build exists", () => {
		const root = fakePackage(["dist/cli/bin.js", "src/cli/bin.ts"]);
		expect(findCliEntry(join(root, "src/environment"))).toBe(
			join(root, "src/cli/bin.ts"),
		);
	});

	it("finds nothing outside a recognizable package", () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo-no-package-"));
		roots.push(root);
		expect(findCliEntry(root)).toBeUndefined();
	});
});

describe("buncargoCli", () => {
	it("names buncargo's own CLI, never the script that is running", () => {
		// Under `bun test` the running script is the test runner, the same way
		// it is the user's script under a library `start()`.
		const cli = buncargoCli();
		expect(cli.program).toBe(process.execPath);
		expect(cli.script).toBe(join(import.meta.dir, "..", "cli", "bin.ts"));
		expect(cli.script).not.toBe(process.argv[1]);
	});
});
