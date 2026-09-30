export interface StartupBudget {
	warmP95Ms: number;
	coldP95Ms: number;
	subprocesses: number;
	cleanupP95Ms?: number;
}
export interface StartupFixture {
	scenario: string;
	parallel: number;
	apps: number;
	sameCheckout?: boolean;
	budget: StartupBudget;
}
/** Separate ceilings keep inexpensive paths from hiding behind service-start budgets. */
export const startupFixtures: StartupFixture[] = [
	{ scenario: "secrets", parallel: 1, apps: 2, budget: {warmP95Ms: 1000, coldP95Ms: 1700, subprocesses: 17} },
	{
		scenario: "services",
		parallel: 1,
		apps: 1,
		budget: { warmP95Ms: 700, coldP95Ms: 1600, subprocesses: 14 },
	},
	{
		scenario: "services",
		parallel: 4,
		apps: 4,
		budget: { warmP95Ms: 1000, coldP95Ms: 2500, subprocesses: 18 },
	},
	{
		scenario: "apps",
		parallel: 4,
		apps: 4,
		budget: { warmP95Ms: 650, coldP95Ms: 1400, subprocesses: 10 },
	},
	{
		scenario: "allocation",
		parallel: 4,
		apps: 2,
		budget: { warmP95Ms: 1100, coldP95Ms: 2500, subprocesses: 19 },
	},
	{
		scenario: "workers",
		parallel: 4,
		apps: 4,
		budget: { warmP95Ms: 500, coldP95Ms: 1000, subprocesses: 24 },
	},
	{
		scenario: "preparation",
		parallel: 1,
		apps: 1,
		budget: { warmP95Ms: 750, coldP95Ms: 1700, subprocesses: 16 },
	},
	{
		scenario: "reuse",
		parallel: 4,
		apps: 1,
		sameCheckout: true,
		budget: { warmP95Ms: 350, coldP95Ms: 600, subprocesses: 3 },
	},
	{
		scenario: "cancel",
		parallel: 1,
		apps: 1,
		budget: {
			warmP95Ms: 750,
			coldP95Ms: 1600,
			subprocesses: 14,
			cleanupP95Ms: 300,
		},
	},
];

export interface StartupResult {
	scenario: string;
	parallel: number;
	appCount: number;
	sameCheckout?: boolean;
	subprocesses: number;
	entryToCliReadyMs?: { p95: number };
	coldEntryToCliReadyMs?: { p95: number };
	cleanupMs?: { p95: number };
}
export function fixtureKey(
	input: Pick<
		StartupResult,
		"scenario" | "parallel" | "appCount" | "sameCheckout"
	>,
): string {
	return `${input.scenario}:${input.parallel}:${input.appCount}:${input.sameCheckout ?? false}`;
}

export function budgetViolations(
	result: StartupResult,
	budget: StartupBudget,
): string[] {
	const metrics =
		result.scenario === "cancel"
			? ([
					["cleanup p95", result.cleanupMs?.p95, budget.cleanupP95Ms ?? 300],
				] as const)
			: ([
					["warm p95", result.entryToCliReadyMs?.p95, budget.warmP95Ms],
					["cold p95", result.coldEntryToCliReadyMs?.p95, budget.coldP95Ms],
				] as const);
	return [
		...metrics,
		["subprocesses", result.subprocesses, budget.subprocesses] as const,
	].flatMap(([name, value, limit]) => {
		if (value === undefined || !Number.isFinite(value) || value < 0)
			return [`${name} is missing or invalid`];
		return value > limit ? [`${name}: ${value} exceeds ${limit}`] : [];
	});
}

/** Same-runner baselines catch smaller regressions with a 50ms noise allowance. */
export function baselineViolations(
	result: StartupResult,
	baseline: StartupResult,
	maxRegressionPercent: number,
): string[] {
	const pairs = [
		[
			"warm p95",
			result.entryToCliReadyMs?.p95,
			baseline.entryToCliReadyMs?.p95,
		],
		[
			"cold p95",
			result.coldEntryToCliReadyMs?.p95,
			baseline.coldEntryToCliReadyMs?.p95,
		],
		["cleanup p95", result.cleanupMs?.p95, baseline.cleanupMs?.p95],
	] as const;
	return pairs.flatMap(([name, value, previous]) => {
		if (value === undefined && previous === undefined) return [];
		if (
			value === undefined ||
			previous === undefined ||
			!Number.isFinite(previous) ||
			previous < 0
		)
			return [`${name} cannot be compared with the baseline`];
		const limit =
			previous + Math.max(50, (previous * maxRegressionPercent) / 100);
		return value > limit
			? [
					`${name}: ${value} exceeds baseline allowance ${Math.round(limit)} (${previous} + ${maxRegressionPercent}%, minimum 50ms)`,
				]
			: [];
	});
}
