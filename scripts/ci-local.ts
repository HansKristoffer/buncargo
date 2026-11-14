/**
 * What `.github/workflows/ci.yml` runs, on this machine, with the variables a
 * GitHub runner sets: `bun run ci:local`.
 *
 * A PR went red four times in 34 minutes on failures only CI found: tests
 * that cleared `CI` but not `GITHUB_ACTIONS`, and scripts only CI runs
 * (`verify-docker.ts`, the startup benchmark). The jobs and their commands
 * are read from the workflow, so a step added there runs here too.
 *
 *   bun run ci:local                 every job but the opt-in ones
 *   bun run ci:local --job=lint,test only these
 *   bun run ci:local --job=docker    an opt-in job, by name
 *   bun run ci:local --list          the commands, without running them
 *
 * The last line is `PASS` or `FAIL: <jobs>`, and the exit code matches.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WORKFLOW = ".github/workflows/ci.yml";

/**
 * Jobs that run only when named: each reaches outside the checkout. The
 * others isolate `HOME` and the container runtime themselves.
 */
export const OPT_IN_JOBS: Readonly<Record<string, string>> = {
	docker:
		"creates real containers on this machine's Docker daemon and writes port claims to ~/.buncargo",
	frp: "downloads frp and builds the relay with Go",
};

export interface CiStep {
	name: string;
	run: string;
}

export interface CiJob {
	name: string;
	steps: CiStep[];
	/** Steps this machine cannot run: an action, or a `${{ }}` expression. */
	skipped: string[];
	/** The other operating systems of the job's matrix, which only CI covers. */
	otherPlatforms: string[];
}

interface WorkflowStep {
	name?: string;
	run?: string;
	uses?: string;
}

interface Workflow {
	jobs: Record<
		string,
		{ steps?: WorkflowStep[]; strategy?: { matrix?: { os?: string[] } } }
	>;
}

/** A runner label of this machine's operating system: `ubuntu-latest` on Linux. */
function runsHere(os: string, platform: NodeJS.Platform): boolean {
	return os.startsWith(platform === "darwin" ? "macos" : "ubuntu");
}

/** The jobs of a workflow and the commands each runs, in order. */
export function readCiJobs(
	workflow: string,
	platform: NodeJS.Platform,
): CiJob[] {
	const { jobs } = Bun.YAML.parse(workflow) as Workflow;
	return Object.entries(jobs).map(([name, job]) => {
		const steps: CiStep[] = [];
		const skipped: string[] = [];
		for (const step of job.steps ?? []) {
			const label = step.name ?? step.run?.split("\n")[0] ?? step.uses ?? "";
			if (step.run === undefined) skipped.push(label);
			// Only a runner can evaluate an expression.
			else if (step.run.includes("${{")) skipped.push(label);
			else steps.push({ name: label, run: step.run });
		}
		const otherPlatforms = (job.strategy?.matrix?.os ?? []).filter(
			(os) => !runsHere(os, platform),
		);
		return { name, steps, skipped, otherPlatforms };
	});
}

/**
 * The jobs a run takes: the named ones, else every job with a command that
 * is not opt-in. Throws on a name the workflow does not have.
 */
export function selectCiJobs(
	jobs: readonly CiJob[],
	named: readonly string[] | undefined,
): CiJob[] {
	if (!named)
		return jobs.filter(
			(job) => job.steps.length > 0 && !(job.name in OPT_IN_JOBS),
		);
	const unknown = named.filter(
		(name) => !jobs.some((job) => job.name === name),
	);
	if (unknown.length > 0) {
		const known = jobs.map((job) => job.name).join(", ");
		const message = `No job named ${unknown.join(", ")} in ${WORKFLOW}. Jobs: ${known}`;
		throw new Error(message);
	}
	return jobs.filter((job) => named.includes(job.name));
}

/**
 * A runner's environment: the two variables every CI check keys off, and
 * none of this shell's buncargo flags, which no runner has.
 */
export function ciEnvironment(
	env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
	const runner: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(env))
		if (!name.startsWith("BUNCARGO_")) runner[name] = value;
	return { ...runner, CI: "true", GITHUB_ACTIONS: "true" };
}

/** Runs a job's steps as a runner does, stopping at the first that fails. */
async function runJob(
	job: CiJob,
	env: Record<string, string | undefined>,
): Promise<boolean> {
	for (const step of job.steps) {
		console.log(`\n▸ ${job.name} › ${step.name}`);
		const child = Bun.spawn(["bash", "-e", "-c", step.run], {
			cwd: ROOT,
			env,
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await child.exited;
		if (code !== 0) {
			console.log(`✗ ${job.name} › ${step.name} (exit ${code})`);
			return false;
		}
	}
	return true;
}

async function main(args: readonly string[]): Promise<number> {
	const named = args
		.find((arg) => arg.startsWith("--job="))
		?.slice("--job=".length)
		.split(",")
		.filter(Boolean);
	const jobs = readCiJobs(
		readFileSync(join(ROOT, WORKFLOW), "utf8"),
		process.platform,
	);
	const selected = selectCiJobs(jobs, named);

	if (args.includes("--list")) {
		for (const job of selected)
			for (const step of job.steps) console.log(`${job.name}\t${step.run}`);
		return 0;
	}

	const env = ciEnvironment(process.env);
	const failed: string[] = [];
	for (const job of selected)
		if (!(await runJob(job, env))) failed.push(job.name);

	console.log("");
	for (const job of selected) {
		const mark = failed.includes(job.name) ? "✗" : "✓";
		console.log(`${mark} ${job.name}`);
		if (job.otherPlatforms.length > 0)
			console.log(`  - only CI runs it on ${job.otherPlatforms.join(", ")}`);
	}
	for (const job of jobs) {
		if (selected.includes(job) || job.steps.length === 0) continue;
		const reason = OPT_IN_JOBS[job.name] ?? "not named in --job";
		console.log(`- ${job.name} not run: ${reason} (--job=${job.name})`);
	}
	console.log(failed.length > 0 ? `FAIL: ${failed.join(", ")}` : "PASS");
	return failed.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
