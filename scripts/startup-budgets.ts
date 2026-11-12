/**
 * What each startup scenario does, and how long it may take.
 *
 * Only the contract gates: the phases a run goes through and the processes it
 * forks move only when the code does. Milliseconds on a shared runner move
 * with the neighbours, so the budgets below warn and never fail.
 */
export interface StartupContract {
	/** The phases every sample reports, in any order. */
	phases: readonly string[];
	/** The most processes one warm sample forks, per platform. */
	subprocesses: { linux: number; darwin: number };
}
/** Reported against, never failed on. */
export interface StartupBudget {
	warmP95Ms: number;
	coldP95Ms: number;
	cleanupP95Ms?: number;
}
export interface StartupFixture {
	scenario: string;
	parallel: number;
	apps: number;
	sameCheckout?: boolean;
	contract: StartupContract;
	budget: StartupBudget;
}

const beforeApps = [
	"config and ports",
	"checks",
	"preflight",
	"secrets session",
	"hosts",
] as const;
const toReady = [
	"app ports",
	"entry to first app spawn",
	"tunnels",
	"app readiness",
] as const;
const appsOnly = [...beforeApps, "dotenv", ...toReady];
const withServices = [
	...beforeApps,
	"containers",
	"dotenv",
	"seed",
	...toReady,
];
const withMigrations = [...withServices, "migrations"];

/** Separate ceilings keep inexpensive paths from hiding behind service-start budgets. */
export const startupFixtures: StartupFixture[] = [
	{
		scenario: "seed-serial",
		parallel: 1,
		apps: 1,
		contract: {
			phases: withMigrations,
			subprocesses: { linux: 11, darwin: 15 },
		},
		budget: { warmP95Ms: 1200, coldP95Ms: 1900 },
	},
	{
		scenario: "seed-parallel",
		parallel: 1,
		apps: 1,
		contract: {
			phases: withMigrations,
			subprocesses: { linux: 11, darwin: 15 },
		},
		budget: { warmP95Ms: 750, coldP95Ms: 1700 },
	},
	{
		scenario: "secrets",
		parallel: 1,
		apps: 2,
		contract: {
			phases: [...withMigrations, "secrets"],
			subprocesses: { linux: 13, darwin: 17 },
		},
		budget: { warmP95Ms: 1000, coldP95Ms: 1700 },
	},
	{
		scenario: "services",
		parallel: 1,
		apps: 1,
		contract: {
			phases: withServices,
			subprocesses: { linux: 9, darwin: 13 },
		},
		budget: { warmP95Ms: 700, coldP95Ms: 1600 },
	},
	{
		scenario: "services",
		parallel: 4,
		apps: 4,
		contract: {
			phases: withServices,
			subprocesses: { linux: 12, darwin: 17 },
		},
		budget: { warmP95Ms: 1000, coldP95Ms: 2500 },
	},
	{
		scenario: "apps",
		parallel: 4,
		apps: 4,
		contract: { phases: appsOnly, subprocesses: { linux: 6, darwin: 9 } },
		budget: { warmP95Ms: 650, coldP95Ms: 1400 },
	},
	{
		scenario: "allocation",
		parallel: 4,
		apps: 2,
		contract: {
			phases: withServices,
			subprocesses: { linux: 13, darwin: 18 },
		},
		budget: { warmP95Ms: 1100, coldP95Ms: 2500 },
	},
	{
		scenario: "workers",
		parallel: 4,
		apps: 4,
		contract: { phases: appsOnly, subprocesses: { linux: 4, darwin: 17 } },
		budget: { warmP95Ms: 500, coldP95Ms: 1000 },
	},
	{
		scenario: "preparation",
		parallel: 1,
		apps: 1,
		contract: {
			phases: withMigrations,
			subprocesses: { linux: 11, darwin: 15 },
		},
		budget: { warmP95Ms: 750, coldP95Ms: 1700 },
	},
	{
		scenario: "reuse",
		parallel: 4,
		apps: 1,
		sameCheckout: true,
		contract: {
			phases: [...beforeApps, "dotenv", "app ports"],
			subprocesses: { linux: 1, darwin: 3 },
		},
		budget: { warmP95Ms: 350, coldP95Ms: 600 },
	},
	{
		scenario: "cancel",
		parallel: 1,
		apps: 1,
		contract: {
			phases: [
				...beforeApps,
				"containers",
				"dotenv",
				"seed",
				"app ports",
				"entry to first app spawn",
			],
			subprocesses: { linux: 9, darwin: 13 },
		},
		budget: { warmP95Ms: 750, coldP95Ms: 1600, cleanupP95Ms: 300 },
	},
];

/** One sample's `--timing-json` report, as `benchmark-startup.ts` prints it. */
interface StartupSample {
	cli: { phases: ReadonlyArray<{ name: string }> };
}
export interface StartupResult {
	scenario: string;
	parallel: number;
	appCount: number;
	sameCheckout?: boolean;
	/** The most any warm sample forked. */
	subprocesses: number;
	entryToCliReadyMs?: { p95: number };
	coldEntryToCliReadyMs?: { p95: number };
	cleanupMs?: { p95: number };
	values: StartupSample[];
	cold: StartupSample[];
}
export function fixtureKey(
	input: Pick<
		StartupResult,
		"scenario" | "parallel" | "appCount" | "sameCheckout"
	>,
): string {
	return `${input.scenario}:${input.parallel}:${input.appCount}:${input.sameCheckout ?? false}`;
}

const sortedNames = (names: Iterable<string>) => [...names].sort().join(", ");

/** Why `result` breaks its scenario's contract on `platform`; empty when it holds. */
export function contractViolations(
	result: StartupResult,
	contract: StartupContract,
	platform: NodeJS.Platform,
): string[] {
	const violations: string[] = [];

	const ceiling =
		platform === "linux" || platform === "darwin"
			? contract.subprocesses[platform]
			: undefined;
	if (ceiling === undefined)
		violations.push(`no subprocess ceiling for ${platform}`);
	else if (!Number.isInteger(result.subprocesses) || result.subprocesses < 0)
		violations.push("subprocesses is missing or invalid");
	else if (result.subprocesses > ceiling)
		violations.push(`subprocesses: ${result.subprocesses} exceeds ${ceiling}`);

	const expected = sortedNames(contract.phases);
	const samples = [...result.values, ...result.cold];
	if (samples.length === 0) violations.push("no samples were reported");
	const seen = new Set(
		samples.map((sample) =>
			sortedNames(sample.cli.phases.map((phase) => phase.name)),
		),
	);
	for (const phases of seen)
		if (phases !== expected)
			violations.push(`phases: [${phases}], expected [${expected}]`);

	return violations;
}

/** Timings over their budget, for the log. */
export function timingWarnings(
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
	return metrics.flatMap(([name, value, limit]) => {
		if (value === undefined || !Number.isFinite(value) || value < 0)
			return [`${name} is missing or invalid`];
		return value > limit ? [`${name}: ${value} exceeds ${limit}`] : [];
	});
}

/** Timings well over a same-runner baseline, with a 50ms noise allowance, for the log. */
export function baselineWarnings(
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
