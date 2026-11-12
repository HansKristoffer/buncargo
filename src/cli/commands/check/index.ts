import { existsSync } from "node:fs";
import { join } from "node:path";
import { getErrorMessage, typedSwitch } from "hanzio";
import { buncargoCli } from "../../../core/cli-entry";
import { findMonorepoRoot } from "../../../core/ports";
import { isGitHubActions } from "../../../core/runtime-flags";
import { loadCheckConfig } from "../../../loader/config-settings";
import { changedFilesSince } from "../../../typecheck/changed";
import type { CheckConfig } from "../../../types";
import {
	BASE_EXITS,
	commaList,
	defineCommand,
	defineGroup,
	type Parsed,
} from "../../command-spec";
import { argumentsError, CliError } from "../../errors";
import type { CheckPlanJson } from "../../json-documents";
import { bunInstallCommand, pinnedBunVersion } from "./bun-version";
import {
	docPathsConfig,
	findDocProblems,
	formatDocProblem,
	markdownFiles,
} from "./docs";
import {
	type CheckMode,
	type CheckPlan,
	filterPlan,
	type InlineStep,
	planCheck,
	stepNames,
	testsFor,
} from "./plan";
import { formatVerdict, stepRerun, stepRunner, verdictFails } from "./runner";

const BIOME_CONFIGS = ["biome.json", "biome.jsonc"];

function stagedFiles(root: string): string[] {
	const result = Bun.spawnSync(
		["git", "diff", "--cached", "--name-only", "--relative", "--diff-filter=d"],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0)
		throw new CliError("check --staged: git could not list staged files.");
	return result.stdout.toString().split("\n").filter(Boolean);
}

/** A comma-separated `--only`/`--skip` value; names are checked against the plan later. */
function stepList(
	flag: string,
	value: string | undefined,
	errors: string[],
): string[] | undefined {
	if (value === undefined) return undefined;
	const names = commaList(value);
	if (names.length === 0)
		errors.push(`--${flag} requires at least one step name.`);
	return names;
}

function unknownStepErrors(
	config: CheckConfig,
	lists: readonly (readonly string[] | undefined)[],
): string[] {
	const known = stepNames(config);
	const unknown = lists
		.flatMap((names) => names ?? [])
		.filter((name) => !known.includes(name));
	if (unknown.length === 0) return [];
	return [
		`Unknown check step${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Known: ${known.join(", ")}`,
	];
}

/** `check --list`: the plan, as names and rerun commands or as JSON. */
function printPlan(plan: CheckPlan, mode: CheckMode, json: boolean): void {
	const steps = plan.steps.map((step) => ({
		name: step.name,
		label: step.label,
		command: stepRerun(step),
	}));
	if (json) {
		console.log(
			JSON.stringify(
				{
					mode,
					steps,
					deferredTests: plan.deferred ?? null,
				} satisfies CheckPlanJson,
				null,
				2,
			),
		);
		return;
	}
	for (const step of steps)
		console.log(`${step.name}\t${step.label}\t${step.command}`);
	if (plan.deferred) console.log(`tests (not run)\t${plan.deferred.command}`);
}

/** `check docs`: every Markdown file, with a summary line either way. */
function checkAllDocs(root: string, config: CheckConfig): number {
	const files = markdownFiles(root);
	const problems = findDocProblems(root, files, docPathsConfig(config.docs));
	for (const problem of problems) console.error(formatDocProblem(problem));
	const icon = problems.length > 0 ? "✗" : "✓";
	const summary = `${icon} docs: ${files.length} files, ${problems.length} problems`;
	if (problems.length > 0) console.error(summary);
	else console.log(summary);
	return problems.length > 0 ? 1 : 0;
}

const CHECK_SPEC = {
	name: "check",
	usage: "check [docs] [options]",
	summary:
		"Biome, typecheck, gates and nearby tests for the change in front of you",
	flags: {
		staged: {
			kind: "boolean",
			description: "Staged files only: no writes, no tests (pre-commit)",
		},
		all: {
			kind: "boolean",
			description: "Every file, workspace and gate; no tests (lint)",
		},
		base: {
			kind: "string",
			value: "<ref>",
			description:
				"Compare with the merge base of <ref> (default: origin's default branch)",
		},
		only: {
			kind: "string",
			value: "<steps>",
			description: "Run only these steps (comma-separated names from --list)",
		},
		skip: {
			kind: "string",
			value: "<steps>",
			description: "Leave these steps out (comma-separated names from --list)",
		},
		list: {
			kind: "boolean",
			description: "Print the steps this change would run, and run nothing",
		},
		json: {
			kind: "boolean",
			description: "With --list: one JSON document on stdout",
		},
	},
	examples: [
		{
			command: "buncargo check",
			description:
				"Biome, typecheck, gates and nearby tests for this branch's changes",
		},
		{
			command: "buncargo check --staged",
			description: "The pre-commit hook: staged files, no writes",
		},
		{
			command: "buncargo check --all",
			description: "Every check but the tests, e.g. as `bun run lint`",
		},
		{
			command: "buncargo check --all --list --json",
			description: "Every step's name and command, e.g. for a CI matrix",
		},
		{
			command: "buncargo check --skip=typecheck",
			description: "The rest, when the typecheck runs as its own CI job",
		},
	],
} as const;

async function loadConfig(root: string): Promise<CheckConfig> {
	const settings = await loadCheckConfig(root);
	if (settings.errors.length > 0)
		throw new CliError(settings.errors[0] ?? "Invalid check config.", [
			...settings.errors.slice(1),
		]);
	if (settings.warning) console.warn(settings.warning);
	return settings.config ?? {};
}

async function check({
	values: { base, staged, all, list, json, ...values },
}: Parsed<typeof CHECK_SPEC>): Promise<number> {
	const errors: string[] = [];
	const only = stepList("only", values.only, errors);
	const skip = stepList("skip", values.skip, errors);
	if (staged && all) errors.push("--staged and --all cannot be combined.");
	if (base !== undefined && (staged || all))
		errors.push("--base only applies to the default changed-files mode.");
	if (json && !list) errors.push("--json only applies to --list.");
	if (errors.length > 0) throw argumentsError(errors, "check");

	const root = findMonorepoRoot();
	const config = await loadConfig(root);
	const stepErrors = unknownStepErrors(config, [only, skip]);
	if (stepErrors.length > 0) throw argumentsError(stepErrors, "check");

	const mode: CheckMode = all ? "all" : staged ? "staged" : "changed";

	const changed: string[] = typedSwitch(mode, {
		all: () => [],
		staged: () => stagedFiles(root),
		changed: () => {
			try {
				return changedFilesSince(root, base);
			} catch (error) {
				throw new CliError(
					getErrorMessage(error).replace("--changed", "check"),
					["Pass --base=<ref>, or --all to check everything."],
				);
			}
		},
	});
	// Deleted paths select workspaces and gates; the formatters cannot read them.
	const existing = changed.filter((file) => existsSync(join(root, file)));
	const tests =
		mode === "changed"
			? await testsFor(root, changed, {
					exclude: config.testExclude,
					also: config.testAlso,
				})
			: [];
	const cli = buncargoCli();
	const plan = filterPlan(
		planCheck(config, { changed, existing, tests }, mode, {
			biome: BIOME_CONFIGS.some((file) => existsSync(join(root, file))),
			pinnedBun: pinnedBunVersion(root),
			buncargo: [cli.program, ...(cli.script ? [cli.script] : [])],
			base,
		}),
		{ only, skip },
	);

	if (list) {
		printPlan(plan, mode, json);
		return 0;
	}
	if (mode !== "all" && changed.length === 0) {
		console.log("nothing changed: PASS");
		return 0;
	}
	return runPlan(root, config, plan);
}

/** Runs the plan's steps in order and prints the verdict; resolves to the exit code. */
async function runPlan(
	root: string,
	config: CheckConfig,
	plan: CheckPlan,
): Promise<number> {
	const runner = stepRunner(root, console.log, { github: isGitHubActions() });
	for (const step of plan.steps) {
		if (step.kind === "command") await runner.run(step);
		else runner.inline(step, inlineProblems(root, config, step));
	}

	for (const line of formatVerdict(runner.failures, plan.deferred))
		console.log(line);
	return verdictFails(runner.failures, plan.deferred) ? 1 : 0;
}

/** What a step `check` does itself finds. */
function inlineProblems(
	root: string,
	config: CheckConfig,
	step: InlineStep,
): string[] {
	if (step.kind === "docs")
		return findDocProblems(
			root,
			markdownFiles(root),
			docPathsConfig(config.docs),
		).map(formatDocProblem);

	if (Bun.version === step.pinned) return [];
	const install = bunInstallCommand(step.pinned);
	const problem = `Running Bun ${Bun.version}, but .bun-version pins ${step.pinned}: ${install}`;
	if (step.required) return [problem];
	console.log(`! ${problem}`);
	return [];
}

const changeCommand = defineCommand({
	spec: CHECK_SPEC,
	exits: { ...BASE_EXITS, 1: "a step failed, or bad arguments" },
	json: "CheckPlanJson (--list --json)",
	run: (parsed) => check(parsed),
});

export const checkCommand = defineGroup({
	spec: {
		name: "check",
		usage: CHECK_SPEC.usage,
		summary: CHECK_SPEC.summary,
	},
	subcommands: {
		docs: defineCommand({
			spec: {
				name: "check docs",
				summary:
					"Only check Markdown links and documented commands, in every doc",
				flags: {},
			},
			exits: { ...BASE_EXITS, 1: "a doc has a problem" },
			run: async () => {
				const root = findMonorepoRoot();
				return checkAllDocs(root, await loadConfig(root));
			},
		}),
	},
	fallback: changeCommand,
});
