/** Real CLI/apps with isolated runtime fixtures and scenario-specific regression limits. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	baselineViolations,
	budgetViolations,
	fixtureKey,
	startupFixtures,
	type StartupResult,
} from "./startup-budgets";

const option = (name: string) =>
	process.argv
		.find((arg) => arg.startsWith(`--${name}=`))
		?.slice(name.length + 3);
function positiveOption(name: string, fallback?: number): number | undefined {
	const raw = option(name);
	const value = raw === undefined ? fallback : Number(raw);
	if (value !== undefined && (!Number.isFinite(value) || value <= 0))
		throw new Error(`--${name} must be a positive finite number`);
	return value;
}
const samples = positiveOption("samples", 5)!;
if (!Number.isInteger(samples)) throw new Error("--samples must be an integer");
const output = resolve(option("output") ?? ".buncargo/benchmarks/startup.json");
const scale = positiveOption("budget-scale", 1)!;
const maxColdP95 = positiveOption("max-cold-p95");
const maxP95 = positiveOption("max-p95");
const maxSubprocesses = positiveOption("max-subprocesses");
const maxRegressionPercent = positiveOption("max-regression-percent", 25)!;
const baselinePath = option("baseline");
const baseline = baselinePath
	? (JSON.parse(readFileSync(baselinePath, "utf8")) as {
			platform: string;
			bun: string;
			interrupted?: boolean;
			results: StartupResult[];
			failures?: string[];
		})
	: undefined;
if (
	baseline &&
	(baseline.platform !== process.platform ||
		baseline.bun !== Bun.version ||
		baseline.interrupted ||
		baseline.failures?.length ||
		!Array.isArray(baseline.results) ||
		startupFixtures.some(
			(fixture) =>
				!baseline.results.some(
					(result) =>
						fixtureKey(result) ===
						fixtureKey({ ...fixture, appCount: fixture.apps }),
				),
		))
)
	throw new Error(
		"The baseline must be a successful complete matrix on the same platform and Bun version",
	);

let interruptCode: number | undefined;
let interruptChild: ((signal: "SIGINT" | "SIGTERM") => void) | undefined;
const onInt = () => {
	interruptCode = 130;
	interruptChild?.("SIGINT");
};
const onTerm = () => {
	interruptCode = 143;
	interruptChild?.("SIGTERM");
};
process.once("SIGINT", onInt);
process.once("SIGTERM", onTerm);
const results: unknown[] = [];
const failures: string[] = [];

try {
	for (const fixture of startupFixtures) {
		if (interruptCode !== undefined) break;
		const budget = {
			warmP95Ms: maxP95 ?? Math.round(fixture.budget.warmP95Ms * scale),
			coldP95Ms: maxColdP95 ?? Math.round(fixture.budget.coldP95Ms * scale),
			subprocesses: maxSubprocesses ?? fixture.budget.subprocesses,
			cleanupP95Ms: Math.round((fixture.budget.cleanupP95Ms ?? 300) * scale),
		};
		const child = Bun.spawn(
			[
				process.execPath,
				"scripts/benchmark-startup.ts",
				`--scenario=${fixture.scenario}`,
				`--parallel=${fixture.parallel}`,
				`--apps=${fixture.apps}`,
				`--samples=${samples}`,
				"--app-delay=0",
				...(fixture.sameCheckout ? ["--same-checkout"] : []),
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		interruptChild = (signal) => {
			child.kill(signal);
		};
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		interruptChild = undefined;
		if (interruptCode !== undefined) break;
		const key = fixtureKey({ ...fixture, appCount: fixture.apps });
		if (code !== 0) {
			results.push({ ...fixture, budget, error: stderr });
			failures.push(`${key}: fixture exited ${code}: ${stderr}`);
			continue;
		}
		const result = JSON.parse(stdout) as StartupResult;
		const violations = budgetViolations(result, budget);
		if (baseline) {
			const previous = baseline.results.find(
				(item) => fixtureKey(item) === key,
			);
			if (!previous)
				violations.push("Matching fixture is missing from the baseline");
			else
				violations.push(
					...baselineViolations(result, previous, maxRegressionPercent),
				);
		}
		results.push({ ...result, budget, violations });
		failures.push(...violations.map((message) => `${key}: ${message}`));
		console.log(
			JSON.stringify({
				key,
				p95Ms: result.entryToCliReadyMs?.p95,
				cleanupP95Ms: result.cleanupMs?.p95,
				subprocesses: result.subprocesses,
				budget,
				violations,
			}),
		);
	}
} finally {
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(
		output,
		`${JSON.stringify({ bun: Bun.version, platform: process.platform, interrupted: interruptCode !== undefined, baseline: baselinePath, maxRegressionPercent, results, failures }, null, 2)}\n`,
	);
	console.log(`Saved ${output}`);
	process.off("SIGINT", onInt);
	process.off("SIGTERM", onTerm);
}
if (interruptCode !== undefined) process.exitCode = interruptCode;
else if (failures.length)
	throw new Error(`Startup regressions:\n${failures.join("\n")}`);
