import { existsSync } from "node:fs";
import { join } from "node:path";
import { chunkArray } from "hanzio";
import { BUILT_IN_CHECK_STEPS } from "../../../config/validation/config-shapes";
import { isRootWideFile } from "../../../typecheck/changed";
import { globPaths } from "../../../typecheck/glob";
import type {
	CheckConfig,
	CheckGateConfig,
	CheckTestAlsoConfig,
} from "../../../types";

export type CheckMode = "changed" | "staged" | "all";

// Chunked so a large change never hits the argument-length limit.
export const FILE_CHUNK = 200;

export type CheckStepName = (typeof BUILT_IN_CHECK_STEPS)[number];

/** A step that runs a command. */
export interface CommandStep {
	kind: "command";
	/** What `--only`, `--skip` and `--list` call it; chunks share it. */
	name: string;
	/** Shown in the step line: `✓ <label> 1.2s`. */
	label: string;
	command: string[];
	/** Relative to the repository root. */
	cwd?: string;
	/** Run when the step fails, before it runs once more (a gate's `fix`). */
	fix?: string[];
	/** Its output is `bun test`'s, so a failure prints the failed tests. */
	bunTest?: boolean;
}

interface InlineStepBase {
	name: CheckStepName;
	label: string;
	/** How to run it again by hand. */
	rerun: string;
}

/** A step `check` does itself, with no process. */
export type InlineStep =
	| (InlineStepBase & { kind: "docs" })
	| (InlineStepBase & {
			kind: "bun-version";
			pinned: string;
			/** A mismatch fails the check rather than warns: bun fmt runs. */
			required: boolean;
	  });

export type Step = CommandStep | InlineStep;

/** Tests the change selects that need services, so `check` lists them instead. */
export interface DeferredTests {
	files: string[];
	/** The command that runs them. */
	command: string;
	/** Whether leaving them out fails the check. */
	strict: boolean;
}

export interface CheckPlan {
	steps: Step[];
	deferred?: DeferredTests;
}

/** What the plan is made from, read by the caller. */
export interface CheckFiles {
	/** The changed or staged files, deleted ones included. Empty with `--all`. */
	changed: readonly string[];
	/** The changed files that still exist: what formatters and Biome can read. */
	existing: readonly string[];
	/** The test files the change selects ({@link testsFor}). */
	tests: readonly string[];
}

/** Facts about the repository and this buncargo the plan depends on. */
export interface CheckRepo {
	/** The root has a `biome.json(c)`. */
	biome: boolean;
	/** The version `.bun-version` pins. */
	pinnedBun?: string;
	/** How to run this buncargo: the program and its script, if any. */
	buncargo: readonly string[];
	/** `--base=<ref>`. */
	base?: string;
}

/**
 * The `bun fmt` runs for `check.format`: write the changed files, check the
 * staged ones, check the whole repo with `--all`. `files` are the ones that
 * still exist. `--no-script` keeps a repo `fmt` script from running instead;
 * the ignore flags let a list hold files bun fmt cannot format.
 */
export function formatCommands(
	format: true | readonly string[],
	files: readonly string[],
	mode: CheckMode,
): { label: string; command: string[] }[] {
	const globs = format === true ? [] : format;
	const flags = [
		"bun",
		"fmt",
		"--no-script",
		...(mode === "changed" ? [] : ["--check"]),
		"--ignore-unknown",
		"--no-error-on-unmatched-pattern",
	];
	const label = mode === "changed" ? "bun fmt" : "bun fmt --check";
	if (mode === "all") return [{ label, command: [...flags, ...globs] }];
	const matchers = globs.map((glob) => new Bun.Glob(glob));
	const selected = files.filter(
		(file) =>
			matchers.length === 0 || matchers.some((glob) => glob.match(file)),
	);
	return chunkArray(selected, FILE_CHUNK).map((chunk) => ({
		label: `${label} (${chunk.length} files)`,
		command: [...flags, ...chunk],
	}));
}

function matchesAny(
	files: readonly string[],
	patterns: readonly string[],
): boolean {
	const globs = patterns.map((pattern) => new Bun.Glob(pattern));
	return files.some((file) => globs.some((glob) => glob.match(file)));
}

/**
 * Whether a step scoped to `patterns` applies to this change. A root-wide
 * file (manifest, lockfile, tsconfig, dev config) touches everything, as it
 * does for `typecheck --changed`, unless `rootWide` is false.
 */
export function touches(
	files: readonly string[],
	patterns: readonly string[],
	mode: CheckMode,
	rootWide = true,
): boolean {
	if (mode === "all") return true;
	return (
		(rootWide && files.some(isRootWideFile)) || matchesAny(files, patterns)
	);
}

/** The gates this change selects, in config order. */
export function selectGates(
	gates: readonly CheckGateConfig[],
	files: readonly string[],
	mode: CheckMode,
): CheckGateConfig[] {
	return gates.filter(
		(gate) =>
			(mode !== "staged" || gate.staged !== false) &&
			(gate.when === undefined ||
				touches(files, gate.when, mode, gate.rootWide !== false)),
	);
}

function biomeSteps(existing: readonly string[], mode: CheckMode): Step[] {
	if (mode === "all")
		return [
			{
				kind: "command",
				name: "biome",
				label: "biome",
				command: ["bunx", "biome", "check"],
			},
		];
	const write = mode === "staged" ? [] : ["--write"];
	const label = mode === "staged" ? "biome" : "biome --write";
	return chunkArray([...existing], FILE_CHUNK).map((chunk) => ({
		kind: "command",
		name: "biome",
		label: `${label} (${chunk.length} files)`,
		command: [
			"bunx",
			"biome",
			"check",
			...write,
			"--files-ignore-unknown=true",
			"--no-errors-on-unmatched",
			...chunk,
		],
	}));
}

/** `sh -c '<command> "$@"' sh <files>`: the files as arguments, never re-parsed. */
function withFiles(command: string, files: readonly string[]): string[] {
	return ["sh", "-c", `${command} "$@"`, "sh", ...files.map((f) => `./${f}`)];
}

function testPlan(
	config: CheckConfig,
	tests: readonly string[],
): Pick<CheckPlan, "deferred"> & { step?: Step } {
	const testCommand = config.testCommand ?? "bun test";
	const deferredConfig = config.testDeferred;
	const deferredGlobs = (deferredConfig?.files ?? []).map(
		(pattern) => new Bun.Glob(pattern),
	);
	const isDeferred = (test: string) =>
		deferredGlobs.some((glob) => glob.match(test));
	const run = tests.filter((test) => !isDeferred(test));
	const deferredFiles = tests.filter(isDeferred);

	const step: Step | undefined =
		run.length > 0
			? {
					kind: "command",
					name: "tests",
					label: `tests (${run.length} files)`,
					command: withFiles(testCommand, run),
					bunTest: /^bunx? test\b/.test(testCommand),
				}
			: undefined;
	if (deferredFiles.length === 0) return { step };

	const deferredCommand = deferredConfig?.command ?? testCommand;
	const shown = deferredFiles.map((file) => `./${file}`).join(" ");
	return {
		step,
		deferred: {
			files: deferredFiles,
			command: `${deferredCommand} ${shown}`,
			strict: deferredConfig?.strict === true,
		},
	};
}

/**
 * What `check` runs for this change, in order: the Bun pin, formatting,
 * Biome, the docs check, the typecheck, the gates and the tests. Pure: the
 * caller reads the files and the repository first.
 */
export function planCheck(
	config: CheckConfig,
	files: CheckFiles,
	mode: CheckMode,
	repo: CheckRepo,
): CheckPlan {
	if (mode !== "all" && files.changed.length === 0) return { steps: [] };
	const steps: Step[] = [];

	// First, as it is the cheapest, and bun fmt's output depends on it.
	if (repo.pinnedBun)
		steps.push({
			kind: "bun-version",
			pinned: repo.pinnedBun,
			required: Boolean(config.format),
			name: "bun-version",
			label: `bun ${repo.pinnedBun} (.bun-version)`,
			rerun: "bun --version",
		});

	// Formatting before Biome, so the lint sees the formatted files. From the
	// root: bun fmt skips `.prettierignore` entries only there.
	if (config.format)
		for (const { label, command } of formatCommands(
			config.format,
			files.existing,
			mode,
		))
			steps.push({ kind: "command", name: "format", label, command });

	if (repo.biome) steps.push(...biomeSteps(files.existing, mode));

	if (
		config.docs !== false &&
		touches(files.changed, ["**/*.md", "*.md"], mode)
	)
		steps.push({
			kind: "docs",
			name: "docs",
			label: "docs",
			rerun: "buncargo check docs",
		});

	// The typecheck picks the changed workspaces and their dependents, and
	// waits for one of the machine-wide check slots. Staged mode compares the
	// working tree with HEAD.
	const changedRef = mode === "staged" ? "HEAD" : repo.base;
	const changedFlag = changedRef ? `--changed=${changedRef}` : "--changed";
	steps.push({
		kind: "command",
		name: "typecheck",
		label: "typecheck",
		command: [
			...repo.buncargo,
			"typecheck",
			...(mode === "all" ? [] : [changedFlag]),
		],
	});

	for (const gate of selectGates(config.gates ?? [], files.changed, mode))
		steps.push({
			kind: "command",
			name: gate.name,
			label: gate.name,
			command: ["sh", "-c", gate.command],
			cwd: gate.cwd,
			// Only the default mode writes: --staged and --all report.
			fix: gate.fix && mode === "changed" ? ["sh", "-c", gate.fix] : undefined,
		});

	// The tests next to the changed files are a handful: light enough to run
	// without a slot.
	if (mode !== "changed") return { steps };
	const tests = testPlan(config, files.tests);
	if (tests.step) steps.push(tests.step);
	return { steps, deferred: tests.deferred };
}

/** Every name `--only` and `--skip` accept for this config. */
export function stepNames(config: CheckConfig): string[] {
	return [
		...BUILT_IN_CHECK_STEPS,
		...(config.gates ?? []).map((gate) => gate.name),
	];
}

/**
 * The plan with `--only` and `--skip` applied. The deferred tests belong to
 * the `tests` step and go with it.
 */
export function filterPlan(
	plan: CheckPlan,
	filter: { only?: readonly string[]; skip?: readonly string[] },
): CheckPlan {
	const keep = (name: string) =>
		(filter.only === undefined || filter.only.includes(name)) &&
		!filter.skip?.includes(name);
	return {
		steps: plan.steps.filter((step) => keep(step.name)),
		...(plan.deferred && keep("tests") ? { deferred: plan.deferred } : {}),
	};
}

/**
 * A changed test file, the tests next to a changed source file
 * (`a.ts` → `a.test.ts`, `a.database.test.ts`), and the `testAlso` tests a
 * changed file selects. Paths relative to `root`.
 */
export async function testsFor(
	root: string,
	files: readonly string[],
	settings: {
		exclude?: readonly string[];
		also?: readonly CheckTestAlsoConfig[];
	},
): Promise<string[]> {
	const tests = new Set<string>();
	for (const file of files) {
		if (/\.test\.[cm]?[jt]sx?$/.test(file)) {
			tests.add(file);
			continue;
		}
		const source = file.match(/^(.*)\.[cm]?[jt]sx?$/);
		if (!source) continue;
		const glob = new Bun.Glob(`${source[1]}{,.*}.test.{ts,tsx,js,jsx}`);
		for await (const test of glob.scan(root)) tests.add(test);
	}
	for (const entry of settings.also ?? [])
		if (matchesAny(files, entry.when))
			for (const test of globPaths(entry.tests, root)) tests.add(test);

	const excluded = (settings.exclude ?? []).map(
		(pattern) => new Bun.Glob(pattern),
	);
	return [...tests]
		.filter(
			(test) =>
				existsSync(join(root, test)) &&
				!excluded.some((glob) => glob.match(test)),
		)
		.sort();
}
