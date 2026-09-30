import { expect, it } from "bun:test";
import {
	baselineViolations,
	budgetViolations,
	fixtureKey,
	startupFixtures,
	type StartupResult,
} from "./startup-budgets";

const result: StartupResult = {
	scenario: "services",
	parallel: 1,
	appCount: 1,
	subprocesses: 13,
	entryToCliReadyMs: { p95: 350 },
	coldEntryToCliReadyMs: { p95: 600 },
};
it("detects regressions that the old shared three-second ceiling missed", () => {
	const budget = startupFixtures.find((fixture) => fixture.scenario === "services" && fixture.parallel === 1)!.budget;
	expect(budgetViolations(result, budget)).toEqual([]);
	expect(
		budgetViolations({ ...result, entryToCliReadyMs: { p95: 900 } }, budget),
	).toEqual(["warm p95: 900 exceeds 700"]);
	expect(budgetViolations({ ...result, subprocesses: 15 }, budget)).toEqual([
		"subprocesses: 15 exceeds 14",
	]);
});
it("requires valid measurements and separately limits cancellation", () => {
	expect(
		budgetViolations(
			{ ...result, entryToCliReadyMs: undefined },
			startupFixtures.find((fixture) => fixture.scenario === "services" && fixture.parallel === 1)!.budget,
		),
	).toContain("warm p95 is missing or invalid");
	expect(
		budgetViolations(
			{ ...result, scenario: "cancel", cleanupMs: { p95: 400 } },
			startupFixtures.at(-1)!.budget,
		),
	).toContain("cleanup p95: 400 exceeds 300");
});
it("compares matching workloads and permits bounded timing noise", () => {
	expect(fixtureKey(result)).not.toBe(fixtureKey({ ...result, parallel: 4 }));
	expect(fixtureKey(result)).not.toBe(
		fixtureKey({ ...result, sameCheckout: true }),
	);
	expect(
		baselineViolations(
			{ ...result, entryToCliReadyMs: { p95: 400 } },
			result,
			25,
		),
	).toEqual([]);
	expect(
		baselineViolations(
			{ ...result, entryToCliReadyMs: { p95: 500 } },
			result,
			25,
		),
	).toHaveLength(1);
	expect(
		baselineViolations(
			{ ...result, entryToCliReadyMs: { p95: 80 } },
			{ ...result, entryToCliReadyMs: { p95: 30 } },
			25,
		),
	).toEqual([]);
});
