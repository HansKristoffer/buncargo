import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getErrorMessage, startTimer, sumBy } from "hanzio";
import { execAsync } from "../core/process";
import { readWorkspaceGraph, selectChangedWorkspaces } from "./changed";
import {
	type ConfigTypecheckResult,
	typecheckRootConfig,
} from "./config-typecheck";
import { countTypeScriptFiles, globPaths } from "./glob";
import { resolveProjectTsc } from "./project-tsc";
import {
	defaultTypecheckConcurrency,
	runBounded,
	selectWorkspaces,
	sortWorkspacesByExpectedDuration,
} from "./scheduling";
import { readTypecheckTimings, writeTypecheckTimings } from "./timings";
import { workspacePatterns } from "./workspaces";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for running workspace typechecks.
 */
export interface WorkspaceTypecheckOptions {
	/** Root directory to search from (defaults to cwd) */
	root?: string;
	/** Glob patterns for workspaces to check (defaults to apps/*, packages/*, modules) */
	patterns?: string[];
	/** Maximum concurrent typecheck processes (defaults from CPUs / CI / env) */
	concurrency?: number;
	/** Print output to console (defaults to true) */
	verbose?: boolean;
	/** Also typecheck the root dev config, which belongs to no workspace (defaults to true) */
	includeRootConfig?: boolean;
	/** Restrict to these workspace paths or basenames */
	only?: string[];
	/**
	 * More directories to check, relative to the root (globs allowed): the
	 * config's `typecheck.include`. Each runs its `typecheck` script, else
	 * `tsc --noEmit -p tsconfig.json`.
	 */
	include?: readonly string[];
	/** Workspaces to leave out: paths, globs or basenames (`typecheck.exclude`) */
	exclude?: readonly string[];
	/**
	 * Check only what these files can break (paths relative to `root`): their
	 * workspaces and the workspaces depending on those. A root manifest,
	 * lockfile, tsconfig or dev config among them checks everything.
	 */
	changedFiles?: readonly string[];
	/**
	 * Cancels the run: the checks it started are terminated, process group and
	 * all, none is started after, and the promise rejects with the abort reason.
	 */
	signal?: AbortSignal;
}

/**
 * Result of a single workspace typecheck.
 */
export interface WorkspaceTypecheckResult {
	workspace: string;
	duration: number;
	success: boolean;
	fileCount: number;
	errorOutput?: string;
}

/**
 * Overall result of running typechecks across all workspaces.
 */
export interface TypecheckResult {
	success: boolean;
	totalDuration: number;
	totalFiles: number;
	workspaceCount: number;
	results: WorkspaceTypecheckResult[];
	/** Present when the root dev config was checked */
	rootConfig?: ConfigTypecheckResult;
	/** Set when `--only` named a workspace that does not exist */
	selectionError?: string;
}

interface Workspace {
	path: string;
	fileCount: number;
	/** How to check it, run in the workspace. Default: its `typecheck` script. */
	command?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/** `file.ts(3,7): error` becomes `file.ts:3:7 - error`, which terminals link. */
function formatErrorOutput(output: string): string {
	return output.replace(/\((\d+),(\d+)\):?/g, ":$1:$2 -").trim();
}

function workspaceLabel(workspace: string, fileCount: number): string {
	return fileCount > 0 ? `${workspace} (${fileCount} files)` : workspace;
}

async function runSingleTypecheck(
	{ path: workspace, fileCount, command }: Workspace,
	root: string,
	verbose: boolean,
	signal: AbortSignal | undefined,
): Promise<WorkspaceTypecheckResult> {
	const elapsed = startTimer();
	if (verbose) {
		console.log(
			`Running typecheck in ${workspaceLabel(workspace, fileCount)}...`,
		);
	}

	const result = await execAsync(
		command ?? [process.execPath, "run", "typecheck"],
		join(root, workspace),
		{},
		{ throwOnError: false, signal },
	);

	const duration = Number((elapsed() / 1000).toFixed(2));
	const success = result.exitCode === 0;
	const parts = success
		? []
		: [result.stdout.trim(), result.stderr.trim()].filter(Boolean);
	const errorOutput = parts.length > 0 ? parts.join("\n") : undefined;

	return { workspace, duration, success, fileCount, errorOutput };
}

function hasTypecheckScript(root: string, path: string): boolean {
	try {
		const pkgJson = JSON.parse(
			readFileSync(join(root, path, "package.json"), "utf-8"),
		) as { scripts?: { typecheck?: string } };
		return Boolean(pkgJson.scripts?.typecheck);
	} catch {
		// No package.json, or an invalid one.
		return false;
	}
}

/** A config entry failing on its own: no directory, or nothing to run there. */
interface IncludeProblem {
	workspace: string;
	message: string;
}

/**
 * The directories `include` names, and how to check each. Unlike discovery,
 * an entry is a promise that something there gets checked, so one that
 * matches nothing, or a directory with neither a `typecheck` script nor a
 * `tsconfig.json`, is reported instead of skipped.
 */
async function resolveIncludedWorkspaces(
	include: readonly string[],
	root: string,
): Promise<{ workspaces: Workspace[]; problems: IncludeProblem[] }> {
	const workspaces: Workspace[] = [];
	const problems: IncludeProblem[] = [];
	const seen = new Set<string>();
	let tsc: string | undefined;

	for (const entry of include) {
		const pattern = entry.replace(/^\.\//, "").replace(/\/$/, "") || ".";
		const directories =
			pattern === "."
				? ["."]
				: globPaths([pattern], root, { directories: true });
		if (directories.length === 0) {
			problems.push({
				workspace: entry,
				message: `typecheck.include: "${entry}" matches no directory.`,
			});
			continue;
		}
		for (const path of directories.sort()) {
			if (seen.has(path)) continue;
			seen.add(path);
			if (hasTypecheckScript(root, path)) {
				workspaces.push({ path, fileCount: 0 });
			} else if (existsSync(join(root, path, "tsconfig.json"))) {
				try {
					tsc ??= await resolveProjectTsc(root);
				} catch (error) {
					problems.push({
						workspace: path,
						message: getErrorMessage(error),
					});
					continue;
				}
				workspaces.push({
					path,
					fileCount: 0,
					command: [process.execPath, tsc, "--noEmit", "-p", "tsconfig.json"],
				});
			} else {
				problems.push({
					workspace: path,
					message: `typecheck.include: ${path} has no "typecheck" script in a package.json and no tsconfig.json to check.`,
				});
			}
		}
	}
	return { workspaces, problems };
}

/** Whether `exclude` names this workspace: its path, a glob over it, or its basename. */
function excludedPaths(
	exclude: readonly string[],
	root: string,
	workspaces: readonly Workspace[],
): Set<string> {
	const excluded = new Set<string>();
	if (exclude.length === 0) return excluded;
	const patterns = exclude.map((entry) =>
		entry.replace(/^\.\//, "").replace(/\/$/, ""),
	);
	for (const path of globPaths(patterns, root, { directories: true }))
		excluded.add(path);
	for (const workspace of workspaces)
		if (
			patterns.includes(workspace.path) ||
			patterns.includes(basename(workspace.path))
		)
			excluded.add(workspace.path);
	return excluded;
}

async function discoverWorkspaces(
	patterns: string[],
	root: string,
	selection: { include?: readonly string[]; exclude?: readonly string[] } = {},
): Promise<{ workspaces: Workspace[]; problems: IncludeProblem[] }> {
	const matches = globPaths(
		patterns.map((pattern) => `${pattern.replace(/\/$/, "")}/package.json`),
		root,
	);

	const seen = new Set<string>();
	const candidates: Workspace[] = [];
	for (const match of matches) {
		const pkgPath = match.replace("/package.json", "");
		if (seen.has(pkgPath)) continue;
		seen.add(pkgPath);
		if (hasTypecheckScript(root, pkgPath))
			candidates.push({ path: pkgPath, fileCount: 0 });
	}

	// The config's own entries, after discovery: a directory both found and
	// listed is checked once.
	const included = await resolveIncludedWorkspaces(
		selection.include ?? [],
		root,
	);
	for (const workspace of included.workspaces) {
		if (seen.has(workspace.path)) continue;
		seen.add(workspace.path);
		candidates.push(workspace);
	}

	const excluded = excludedPaths(selection.exclude ?? [], root, candidates);
	return {
		workspaces: candidates.filter((workspace) => !excluded.has(workspace.path)),
		problems: included.problems.filter(
			(problem) => !excluded.has(problem.workspace),
		),
	};
}

function logWorkspaceResult(
	result: WorkspaceTypecheckResult,
	verbose: boolean,
): void {
	if (!verbose) return;
	const icon = result.success ? "✅" : "❌";
	const log = result.success ? console.log : console.error;
	log(
		`${icon} ${workspaceLabel(result.workspace, result.fileCount)} ${result.success ? "completed" : "failed"} in ${result.duration.toFixed(2)}s`,
	);
	if (!result.success && result.errorOutput) {
		console.error(`\n${formatErrorOutput(result.errorOutput)}`);
	}
}

function logRootConfigResult(
	rootConfig: ConfigTypecheckResult,
	verbose: boolean,
): void {
	if (!verbose || !rootConfig.configFile) return;
	const icon = rootConfig.success ? "✅" : "❌";
	const log = rootConfig.success ? console.log : console.error;
	log(
		`${icon} ${rootConfig.configFile} ${rootConfig.success ? "completed" : "failed"} in ${rootConfig.duration.toFixed(2)}s`,
	);
	if (!rootConfig.success && rootConfig.errorOutput) {
		console.error(`\n${formatErrorOutput(rootConfig.errorOutput)}`);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Export
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run TypeScript typechecks across all workspaces that have a `typecheck` script.
 *
 * @example
 * ```typescript
 * const result = await runWorkspaceTypecheck({ verbose: true })
 * if (!result.success) {
 *   console.error('Typecheck failed')
 *   process.exit(1)
 * }
 * ```
 */
export async function runWorkspaceTypecheck(
	options: WorkspaceTypecheckOptions = {},
): Promise<TypecheckResult> {
	const {
		root = process.cwd(),
		patterns: overridePatterns,
		verbose = true,
		only,
		include,
		exclude,
		changedFiles,
		signal,
	} = options;
	let includeRootConfig = options.includeRootConfig ?? true;
	const concurrency = options.concurrency ?? defaultTypecheckConcurrency();

	const totalElapsed = startTimer();

	signal?.throwIfAborted();
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new Error("typecheck concurrency must be a positive integer");
	}
	const patterns = workspacePatterns(root, overridePatterns);
	let rootConfig: ConfigTypecheckResult | undefined;

	const timings = await readTypecheckTimings(root);
	const discovered = await discoverWorkspaces(patterns, root, {
		include,
		exclude,
	});
	let workspaces = discovered.workspaces;
	// An `include` entry with nothing to check fails like a workspace would,
	// unless `--only` looks elsewhere.
	const problemResults: WorkspaceTypecheckResult[] = discovered.problems
		.filter(
			(problem) =>
				!only?.length ||
				only.some(
					(name) =>
						problem.workspace === name || basename(problem.workspace) === name,
				),
		)
		.map((problem) => ({
			workspace: problem.workspace,
			duration: 0,
			success: false,
			fileCount: 0,
			errorOutput: problem.message,
		}));
	for (const result of problemResults) logWorkspaceResult(result, verbose);

	if (only && only.length > 0) {
		const { selected, unknown } = selectWorkspaces(workspaces, only);
		if (unknown.length > 0) {
			const known = workspaces.map((workspace) => workspace.path);
			const selectionError = `Unknown workspace${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Known: ${known.join(", ") || "(none)"}`;
			if (verbose) {
				console.error(selectionError);
			}
			return {
				success: false,
				totalDuration: Number((totalElapsed() / 1000).toFixed(2)),
				totalFiles: 0,
				workspaceCount: 0,
				results: [],
				selectionError,
			};
		}
		workspaces = selected;
	}

	if (changedFiles) {
		const selection = selectChangedWorkspaces(
			changedFiles,
			await readWorkspaceGraph(root, patterns),
			workspaces.map((workspace) => workspace.path),
		);
		if (selection.kind === "workspaces") {
			workspaces = workspaces.filter((workspace) =>
				selection.paths.includes(workspace.path),
			);
			includeRootConfig = false;
		}
		if (verbose) {
			console.log(
				selection.kind === "all"
					? "A root config changed: checking everything."
					: `Changed workspaces and their dependents: ${selection.paths.join(", ") || "none"}`,
			);
		}
	}

	// Counted after `--only` and `--changed` narrow the set, so only the
	// workspaces that get checked are walked.
	workspaces = sortWorkspacesByExpectedDuration(
		workspaces.map((workspace) => ({
			...workspace,
			fileCount: countTypeScriptFiles(join(root, workspace.path)),
		})),
		timings,
	);

	if (workspaces.length === 0) {
		const rootConfig = includeRootConfig
			? await typecheckRootConfig({ root, verbose: false, signal })
			: undefined;
		signal?.throwIfAborted();
		if (verbose) {
			if (rootConfig) logRootConfigResult(rootConfig, verbose);
			console.log(
				changedFiles
					? "Nothing to typecheck."
					: "No workspaces with typecheck script found.",
			);
		}
		return {
			success: (rootConfig?.success ?? true) && problemResults.length === 0,
			totalDuration: Number((totalElapsed() / 1000).toFixed(2)),
			totalFiles: 0,
			workspaceCount: 0,
			results: problemResults,
			...(rootConfig ? { rootConfig } : {}),
		};
	}

	if (verbose) {
		console.log(
			`Running typecheck across ${workspaces.length} workspaces with concurrency limit of ${concurrency}...\n`,
		);
	}

	const results: WorkspaceTypecheckResult[] = [];
	const jobs: (() => Promise<void>)[] = [];
	if (includeRootConfig)
		jobs.push(async () => {
			rootConfig = await typecheckRootConfig({ root, verbose: false, signal });
			logRootConfigResult(rootConfig, verbose);
		});
	for (const [i, workspace] of workspaces.entries())
		jobs.push(async () => {
			const result = await runSingleTypecheck(workspace, root, verbose, signal);
			results[i] = result;
			logWorkspaceResult(result, verbose);
		});

	// The checks resolve once their processes are gone, so a cancelled or
	// failed run rejects only after it has stopped everything it started. Its
	// durations are not real ones and stay out of the timings.
	await runBounded(jobs, concurrency, signal);

	await writeTypecheckTimings(root, timings, results);

	const totalDuration = Number((totalElapsed() / 1000).toFixed(2));
	const totalFiles = sumBy(workspaces, "fileCount");
	results.push(...problemResults);
	const success =
		results.every((r) => r.success) && (rootConfig?.success ?? true);

	if (verbose) {
		if (success) {
			console.log(
				`\nAll typecheck checks passed! Total time: ${totalDuration}s (${totalFiles} files)`,
			);
		} else {
			console.error(`\nTypecheck failed. Total time: ${totalDuration}s`);
		}
	}

	return {
		success,
		totalDuration,
		totalFiles,
		workspaceCount: workspaces.length,
		results,
		...(rootConfig ? { rootConfig } : {}),
	};
}
