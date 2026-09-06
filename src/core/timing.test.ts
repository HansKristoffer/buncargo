import { describe, expect, it } from "bun:test";
import { recordStartupMetric } from "./startup-metrics";
import { createNoopPhaseTimer, createPhaseTimer } from "./timing";

describe("startup timing", () => {
	it("includes entry time, failures, and numeric counters in a single report", async () => {
		let now = 30;
		const lines: string[] = [];
		const timer = createPhaseTimer({
			startedAt: 0,
			now: () => now,
			json: true,
			log: (line) => lines.push(line),
		});
		await expect(
			timer.measure("config", async () => {
				now += 10;
				throw new Error("invalid");
			}),
		).rejects.toThrow("invalid");
		recordStartupMetric("subprocesses", 2);
		now = 90;
		timer.report();
		timer.report();
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "null")).toEqual({
			type: "buncargo.startup",
			totalMs: 90,
			phases: [{ name: "config", durationMs: 10 }],
			counters: { subprocesses: 2 },
		});
	});
	it("does not invoke logging when disabled", async () => {
		const timer = createNoopPhaseTimer();
		expect(await timer.measure("work", async () => 42)).toBe(42);
		expect(timer.phases()).toEqual([]);
	});
});
