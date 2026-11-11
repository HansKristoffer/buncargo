import { describe, expect, it } from "bun:test";
import {
	baselineWarnings,
	contractViolations,
	fixtureKey,
	type StartupResult,
	startupFixtures,
	timingWarnings,
} from "./startup-budgets";

const services = startupFixtures.find(
	(fixture) => fixture.scenario === "services" && fixture.parallel === 1,
);
if (!services) throw new Error("No single-run services fixture");
const { contract, budget } = services;

const sample = (phases: readonly string[]) => ({
	cli: { phases: phases.map((name) => ({ name })) },
});
const result: StartupResult = {
	scenario: "services",
	parallel: 1,
	appCount: 1,
	subprocesses: contract.subprocesses.linux,
	entryToCliReadyMs: { p95: 350 },
	coldEntryToCliReadyMs: { p95: 600 },
	values: [sample(contract.phases), sample(contract.phases)],
	cold: [sample(contract.phases)],
};

describe("contractViolations", () => {
	it("holds at the platform's ceiling and fails one subprocess over it", () => {
		expect(contractViolations(result, contract, "linux")).toEqual([]);
		const over = contract.subprocesses.linux + 1;
		expect(
			contractViolations({ ...result, subprocesses: over }, contract, "linux"),
		).toEqual([`subprocesses: ${over} exceeds ${contract.subprocesses.linux}`]);
		// macOS has its own, higher ceiling.
		expect(
			contractViolations({ ...result, subprocesses: over }, contract, "darwin"),
		).toEqual([]);
	});

	it("fails a sample that gains or loses a phase, in any order", () => {
		const reordered = sample([...contract.phases].reverse());
		expect(
			contractViolations({ ...result, values: [reordered] }, contract, "linux"),
		).toEqual([]);

		const lost = sample(contract.phases.filter((name) => name !== "seed"));
		const gained = sample([...contract.phases, "migrations"]);
		for (const changed of [lost, gained]) {
			const violations = contractViolations(
				{ ...result, cold: [changed] },
				contract,
				"linux",
			);
			expect(violations).toHaveLength(1);
			expect(violations[0]).toStartWith("phases: ");
		}
	});

	it("fails a result with no samples or no count", () => {
		expect(
			contractViolations(
				{ ...result, values: [], cold: [] },
				contract,
				"linux",
			),
		).toEqual(["no samples were reported"]);
		expect(
			contractViolations(
				{ ...result, subprocesses: Number.NaN },
				contract,
				"linux",
			),
		).toEqual(["subprocesses is missing or invalid"]);
	});
});

describe("timing warnings", () => {
	it("names a timing over budget without touching the contract", () => {
		const slow = { ...result, entryToCliReadyMs: { p95: 5_000 } };
		expect(timingWarnings(slow, budget)).toEqual([
			`warm p95: 5000 exceeds ${budget.warmP95Ms}`,
		]);
		expect(contractViolations(slow, contract, "linux")).toEqual([]);
	});

	it("allows bounded noise against a same-runner baseline", () => {
		const warm = (p95: number) => ({ ...result, entryToCliReadyMs: { p95 } });
		expect(baselineWarnings(warm(400), result, 25)).toEqual([]);
		expect(baselineWarnings(warm(500), result, 25)).toHaveLength(1);
		// Under 200ms the 50ms floor, not the percentage, is the allowance.
		expect(baselineWarnings(warm(80), warm(30), 25)).toEqual([]);
	});
});

it("keys fixtures by workload", () => {
	expect(fixtureKey(result)).not.toBe(fixtureKey({ ...result, parallel: 4 }));
	expect(fixtureKey(result)).not.toBe(
		fixtureKey({ ...result, sameCheckout: true }),
	);
});
