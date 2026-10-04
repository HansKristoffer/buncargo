import { expect, it } from "bun:test";
import { parsePinnedOffset } from "./ports";

it("pins whole steps only, so a pinned block lines up with allocated ones", () => {
	expect(parsePinnedOffset("2500")).toBe(2500);
	for (const value of ["2550", "-100", "x", undefined])
		expect(() => parsePinnedOffset(value)).toThrow("steps of 100");
});
