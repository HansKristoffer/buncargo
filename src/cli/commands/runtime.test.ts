import { describe, expect, it } from "bun:test";
import { formatEnvDotValue, getEnvDotPath } from "./runtime";

describe("getEnvDotPath", () => {
	const snapshot = {
		ports: { api: 3000, web: 3001 },
		urls: { api: "http://localhost:3000" },
		isWorktree: true,
	};

	it("reads nested values", () => {
		expect(getEnvDotPath(snapshot, "ports.api")).toBe(3000);
		expect(getEnvDotPath(snapshot, "urls.api")).toBe("http://localhost:3000");
		expect(getEnvDotPath(snapshot, "isWorktree")).toBe(true);
	});

	it("returns undefined for missing paths", () => {
		expect(getEnvDotPath(snapshot, "ports.missing")).toBeUndefined();
		expect(getEnvDotPath(snapshot, "ports.api.nested")).toBeUndefined();
	});
});

describe("formatEnvDotValue", () => {
	it("prints scalars raw and objects as JSON", () => {
		expect(formatEnvDotValue(3000)).toBe("3000");
		expect(formatEnvDotValue("http://localhost:3000")).toBe(
			"http://localhost:3000",
		);
		expect(formatEnvDotValue({ api: 3000 })).toBe('{"api":3000}');
	});
});
