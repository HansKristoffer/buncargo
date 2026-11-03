import { expect, test } from "bun:test";
import { fixSourcePaths } from "./fix-sourcemap-sources";

test("a nested entry's map points at the shipped src/, a top-level chunk's is unchanged", () => {
	const nested = fixSourcePaths(
		{ sources: ["../src/cli/bin.ts"] },
		"/pkg/dist/cli/bin.js.map",
		"/pkg/dist",
	);
	expect(nested.sources).toEqual(["../../src/cli/bin.ts"]);

	const chunk = fixSourcePaths(
		{ sources: ["../src/core/ports.ts"] },
		"/pkg/dist/ports-abc.js.map",
		"/pkg/dist",
	);
	expect(chunk.sources).toEqual(["../src/core/ports.ts"]);
});
