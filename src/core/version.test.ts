import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compareVersions,
	isVersionInRange,
	parseVersion,
	readBuncargoVersion,
} from "./version";

describe("compareVersions", () => {
	it("compares numerically, not as strings", () => {
		// The comparison a string sort gets backwards, and the only one that
		// has to be right.
		expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
		expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
		expect(compareVersions("1.2", "1.2.0")).toBe(0);
		expect(compareVersions("2.0.0", "10.0.0")).toBe(-1);
	});

	it("treats unparseable segments as zero rather than as newer", () => {
		expect(compareVersions("nonsense", "0.1.0")).toBe(-1);
	});
});

describe("isVersionInRange", () => {
	it("includes the minimum and excludes the upper bound", () => {
		expect(isVersionInRange("3.90.0", "3.90.0", "5.0.0")).toBe(true);
		expect(isVersionInRange("3.100.0", "3.90.0", "5.0.0")).toBe(true);
		expect(isVersionInRange("3.89.9", "3.90.0", "5.0.0")).toBe(false);
		expect(isVersionInRange("5.0.0", "3.90.0", "5.0.0")).toBe(false);
	});
});

describe("parseVersion", () => {
	it("finds the version in a tool's output", () => {
		expect(parseVersion("2.40.7\n")).toBe("2.40.7");
		expect(parseVersion("Current Shopify CLI version: 3.93.1")).toBe("3.93.1");
		expect(parseVersion("unknown")).toBeUndefined();
	});
});

describe("readBuncargoVersion", () => {
	it("reads this package's version from source", () => {
		const pkg = JSON.parse(
			readFileSync(join(import.meta.dir, "../../package.json"), "utf8"),
		);
		expect(readBuncargoVersion(import.meta.dir)).toBe(pkg.version);
	});

	it("ignores another package's version", () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-version-"));
		try {
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ name: "someone-else", version: "9.9.9" }),
			);
			expect(readBuncargoVersion(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
