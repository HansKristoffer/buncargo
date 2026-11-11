import { existsSync } from "node:fs";
import { join } from "node:path";
import { getErrorMessage, typedSwitch } from "hanzio";
import { buncargoCli } from "../../../core/cli-entry";
import { findMonorepoRoot } from "../../../core/ports";
import { isGitHubActions } from "../../../core/runtime-flags";
import { changedFilesSince } from "../../../typecheck/changed";
import { loadCheckConfig } from "../../../typecheck/config-settings";
import type { CheckConfig } from "../../../types";
import {
	type CommandSpec,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
	readStringFlag,
} from "../../command-spec";
import { argumentsError, CliError } from "../../errors";
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

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	staged: {
		name: "--staged",
		kind: "boolean",
		description: "Staged files only: no writes, no tests (pre-commit)",
	},
	all: {
		name: "--all",
		kind: "boolean",
		description: "Every file, workspace and gate; no tests (lint)",
	},
	base: {
		name: "--base",
		kind: "string",
		valueHint: "=<ref>",
		description:
			"Compare with the merge base of <ref> (default: origin's default branch)",
	},
	only: {
		name: "--only",
		kind: "string",
		valueHint: "=<steps>",
		description: "Run only these steps (comma-separated names from --list)",
	},
	skip: {
		name: "--skip",
		kind: "string",
		valueHint: "=<steps>",
		description: "Leave these steps out (comma-separated names from --list)",
	},
	list: {
		name: "--list",
		kind: "boolean",
		description: "Print the steps this change would run, and run nothing",
	},
	json: {
		name: "--json",
		kind: "boolean",
		description: "With --list: one JSON document on stdout",
	},
} as const satisfies Record<string, FlagSpec>;

export const CHECK_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo check [docs] [--staged | --all] [--base=<ref>]",
	flags: Object.values(FLAGS),
	notes: [
		{
			command: "docs",
			description:
				"Only check Markdown links and documented commands, in every doc",
		},
	],
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
};

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

/** A comma-separated `--only`/`--skip` value, checked against the step names. */
function readStepList(
	args: string[],
	flag: FlagSpec,
	errors: string[],
): string[] | undefined {
	const value = readStringFlag(args, flag, errors);
	if (!readBooleanFlag(args, flag)) return undefined;
	const names = (value ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	if (names.length === 0)
		errors.push(`${flag.name} requires at least one step name.`);
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
				{ mode, steps, deferredTests: plan.deferred ?? null },
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

export async function handleCheck(args: string[]): Promise<number> {
	if (readBooleanFlag(args, FLAGS.help)) {
		console.log(formatCommandHelp(CHECK_COMMAND_SPEC));
		return 0;
	}
	const errors: string[] = [];
	const base = readStringFlag(args, FLAGS.base, errors);
	const staged = readBooleanFlag(args, FLAGS.staged);
	const all = readBooleanFlag(args, FLAGS.all);
	const list = readBooleanFlag(args, FLAGS.list);
	const json = readBooleanFlag(args, FLAGS.json);
	const only = readStepList(args, FLAGS.only, errors);
	const skip = readStepList(args, FLAGS.skip, errors);
	const positionals = readPositionals(CHECK_COMMAND_SPEC, args);
	const docsOnly = positionals[0] === "docs";
	errors.push(
		...findUnknownFlags(CHECK_COMMAND_SPEC, args).map(
			(flag) => `Unknown flag: ${flag}`,
		),
		...positionals
			.slice(docsOnly ? 1 : 0)
			.map((token) => `Unexpected argument: ${token}`),
	);
	if (staged && all) errors.push("--staged and --all cannot be combined.");
	if (base !== undefined && (staged || all))
		errors.push("--base only applies to the default changed-files mode.");
	if (json && !list) errors.push("--json only applies to --list.");
	const stepFlags = list || only !== undefined || skip !== undefined;
	if (docsOnly && stepFlags)
		errors.push(
			"check docs runs one step: --list, --only and --skip do not apply.",
		);
	if (errors.length > 0) throw argumentsError(errors, "check");

	const root = findMonorepoRoot();
	const settings = await loadCheckConfig(root);
	if (settings.errors.length > 0)
		throw new CliError(settings.errors[0] ?? "Invalid check config.", [
			...settings.errors.slice(1),
		]);
	if (settings.warning) console.warn(settings.warning);
	const config = settings.config ?? {};
	const stepErrors = unknownStepErrors(config, [only, skip]);
	if (stepErrors.length > 0) throw argumentsError(stepErrors, "check");

	if (docsOnly) return checkAllDocs(root, config);
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
