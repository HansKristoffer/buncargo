import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveToolBinary } from "./tool-binary";

function tempBinary(name = "tool"): string {
	const path = join(mkdtempSync(join(tmpdir(), "buncargo-tool-")), name);
	writeFileSync(path, "");
	return path;
}

describe("resolveToolBinary", () => {
	it("prefers the override and reports whether it exists", () => {
		const bin = tempBinary();
		expect(
			resolveToolBinary({ override: bin, cachePath: "/cache/tool" }),
		).toEqual({
			path: bin,
			source: "override",
			exists: true,
		});
		expect(
			resolveToolBinary({ override: "/nope/tool", cachePath: "/cache/tool" }),
		).toEqual({ path: "/nope/tool", source: "override", exists: false });
	});

	it("falls back to PATH when a command name is given", () => {
		const resolution = resolveToolBinary({
			cachePath: "/cache/sh",
			pathCommand: "sh",
		});
		expect(resolution.source).toBe("path");
		expect(resolution.exists).toBe(true);
		expect(resolution.path).toContain("sh");
	});

	it("falls back to the download cache", () => {
		const missing = join(tmpdir(), "buncargo-tool-missing", "tool");
		expect(
			resolveToolBinary({
				cachePath: missing,
				pathCommand: "buncargo-definitely-not-installed",
			}),
		).toEqual({ path: missing, source: "cache", exists: false });

		const cached = tempBinary();
		expect(resolveToolBinary({ cachePath: cached })).toEqual({
			path: cached,
			source: "cache",
			exists: true,
		});
	});

	it("skips the PATH lookup when no command name is given", () => {
		const resolution = resolveToolBinary({ cachePath: "/cache/sh" });
		expect(resolution.source).toBe("cache");
	});
});
