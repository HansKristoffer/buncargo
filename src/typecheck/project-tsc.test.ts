import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectTsc } from "./project-tsc";

const created: string[] = [];

afterEach(() => {
	for (const dir of created.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A checkout outside this repository, so no ancestor has a TypeScript. */
function makeCheckout(workspaces: string[]): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "project-tsc-test-")));
	created.push(root);
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces }));
	return root;
}

function writeCompiler(dir: string): string {
	mkdirSync(join(dir, "bin"), { recursive: true });
	writeFileSync(join(dir, "bin", "tsc"), "");
	return join(dir, "bin", "tsc");
}

describe("resolveProjectTsc", () => {
	it("finds a workspace's TypeScript linked in by the isolated linker", async () => {
		const root = makeCheckout(["apps/*"]);
		const store = join(root, "node_modules/.bun/typescript@5/node_modules");
		writeCompiler(join(store, "typescript"));
		mkdirSync(join(root, "apps/web/node_modules"), { recursive: true });
		symlinkSync(
			join(store, "typescript"),
			join(root, "apps/web/node_modules/typescript"),
		);

		expect(await resolveProjectTsc(root)).toBe(
			join(root, "apps/web/node_modules/typescript/bin/tsc"),
		);
	});

	it("skips a workspace the patterns exclude", async () => {
		const root = makeCheckout(["apps/*", "!apps/legacy"]);
		mkdirSync(join(root, "apps/web"), { recursive: true });
		writeCompiler(join(root, "apps/legacy/node_modules/typescript"));

		await expect(resolveProjectTsc(root)).rejects.toThrow(
			"No project TypeScript compiler found",
		);
	});
});
