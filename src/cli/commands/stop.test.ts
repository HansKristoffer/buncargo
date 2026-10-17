import { describe, expect, it } from "bun:test";
import { runStopGraceMs } from "./stop";

describe("runStopGraceMs", () => {
	it("gives a run its own teardown time on top of its slowest app", () => {
		expect(runStopGraceMs({ apps: [] })).toBe(5000);
		expect(
			runStopGraceMs({
				apps: [
					{ name: "web", status: "ready" },
					{ name: "firebase", status: "ready", stopGraceMs: 60_000 },
				],
			}),
		).toBe(65_000);
	});
});
