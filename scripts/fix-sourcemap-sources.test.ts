import { expect, test } from "bun:test";
import { shippedSourceMap } from "./fix-sourcemap-sources";

test("a nested entry's map names the repository's source, a top-level chunk's is unchanged", () => {
	const nested = shippedSourceMap(
		{ sources: ["../src/cli/bin.ts"] },
		"/pkg/dist/cli/bin.js.map",
		"/pkg/dist",
	);
	expect(nested.sources).toEqual(["../../src/cli/bin.ts"]);

	const chunk = shippedSourceMap(
		{ sources: ["../src/core/ports.ts"] },
		"/pkg/dist/ports-abc.js.map",
		"/pkg/dist",
	);
	expect(chunk.sources).toEqual(["../src/core/ports.ts"]);
});

test("a shipped map carries no source text", () => {
	const map = shippedSourceMap(
		{ sources: ["../src/core/ports.ts"], sourcesContent: ["export {}"] },
		"/pkg/dist/ports-abc.js.map",
		"/pkg/dist",
	);
	expect(map).toEqual({ sources: ["../src/core/ports.ts"] });
});
