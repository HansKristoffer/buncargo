import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUserHome } from "./hosts/paths";
import {
	legacyToolCachePath,
	lookupOnPath,
	resolveToolBinary,
	toolCachePath,
} from "./tool-binary";

function tempBinary(name = "tool"): string {
	const path = join(mkdtempSync(join(tmpdir(), "buncargo-tool-")), name);
	writeFileSync(path, "");
	return path;
}

function tempExecutable(name = "tool"): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "buncargo-bin-"));
	const path = join(dir, name);
	writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
	return { dir, path };
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

	// The cache moved out of tmpdir(), which macOS purges. A machine that
	// already downloaded the binary should adopt it rather than fetch it again.
	it("adopts the previous cache location when the new one is empty", () => {
		const legacy = tempBinary();
		expect(
			resolveToolBinary({
				cachePath: join(tmpdir(), "buncargo-tool-missing", "tool"),
				legacyCachePath: legacy,
			}),
		).toEqual({ path: legacy, source: "cache", exists: true });
	});

	it("prefers the current cache over the previous one", () => {
		const current = tempBinary();
		const legacy = tempBinary();
		expect(
			resolveToolBinary({ cachePath: current, legacyCachePath: legacy }).path,
		).toBe(current);
	});

	it("reports the current cache path when neither holds the binary", () => {
		const current = join(tmpdir(), "buncargo-tool-missing", "tool");
		expect(
			resolveToolBinary({
				cachePath: current,
				legacyCachePath: join(tmpdir(), "buncargo-tool-also-missing", "tool"),
			}),
		).toEqual({ path: current, source: "cache", exists: false });
	});
});

describe("toolCachePath", () => {
	it("keeps downloads beside the rest of the buncargo state", () => {
		expect(toolCachePath("mkcert.v1.4.4")).toBe(
			join(resolveUserHome(), ".buncargo", "bin", "mkcert.v1.4.4"),
		);
	});

	it("still knows where earlier versions cached", () => {
		expect(legacyToolCachePath("buncargo-mkcert", "mkcert.v1.4.4")).toBe(
			join(tmpdir(), "buncargo-mkcert", "mkcert.v1.4.4"),
		);
	});
});

/**
 * A `PATH` scan rather than a `command -v` fork: this runs for `docker`,
 * `container` and `mkcert` before a dev run has started anything.
 */
describe("lookupOnPath", () => {
	it("finds an executable on PATH", () => {
		const { dir, path } = tempExecutable("buncargo-fake-tool");
		expect(
			lookupOnPath("buncargo-fake-tool", { PATH: dir } as NodeJS.ProcessEnv),
		).toBe(path);
	});

	it("returns nothing for a command that is not there", () => {
		const { dir } = tempExecutable();
		expect(
			lookupOnPath("buncargo-absent", { PATH: dir } as NodeJS.ProcessEnv),
		).toBeUndefined();
	});

	// A file that happens to share the name but cannot be run is not the tool.
	it("skips a non-executable file with the right name", () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-bin-"));
		writeFileSync(join(dir, "buncargo-not-exec"), "", { mode: 0o644 });
		expect(
			lookupOnPath("buncargo-not-exec", { PATH: dir } as NodeJS.ProcessEnv),
		).toBeUndefined();
	});

	it("takes the first match in PATH order", () => {
		const first = tempExecutable("buncargo-dup");
		const second = tempExecutable("buncargo-dup");
		expect(
			lookupOnPath("buncargo-dup", {
				PATH: `${first.dir}:${second.dir}`,
			} as NodeJS.ProcessEnv),
		).toBe(first.path);
	});

	it("treats a path as a path rather than a PATH lookup", () => {
		const { path } = tempExecutable();
		expect(lookupOnPath(path, { PATH: "" } as NodeJS.ProcessEnv)).toBe(path);
	});

	it("survives an empty or absent PATH", () => {
		expect(lookupOnPath("sh", {} as NodeJS.ProcessEnv)).toBeUndefined();
	});

	it("still finds a real system binary", () => {
		expect(lookupOnPath("sh")).toContain("sh");
	});
});
