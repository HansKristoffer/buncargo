import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import fg from "fast-glob";
import { execAsync } from "../core/process";
import {
	type ConfigTypecheckResult,
	typecheckRootConfig,
} from "./config-typecheck";
import { resolveProjectTsc } from "./project-tsc";
import {
	defaultTypecheckConcurrency,
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
// Constants
// ═══════════════════════════════════════════════════════════════════════════

// Patterns that indicate a corrupted tsgo cache (deadlock/panic)
const CORRUPTED_CACHE_PATTERNS = [
	"all goroutines are asleep - deadlock",
	"fatal error:",
	"panic:",
	"github.com/microsoft/typescript-go",
];

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

function isCorruptedCacheError(output: string): boolean {
	return CORRUPTED_CACHE_PATTERNS.some((pattern) => output.includes(pattern));
}

async function clearTsBuildInfo(
	workspace: string,
	verbose: boolean,
): Promise<void> {
	if (verbose) {
		console.log(`🧹 Clearing corrupted tsbuildinfo cache for ${workspace}...`);
	}
	// Clear both old tsbuildinfo and new tsgo cache
	try {
		const tsbuildInfoFiles = await fg(`${workspace}/**/*.tsbuildinfo`, {
			absolute: true,
		});
		for (const file of tsbuildInfoFiles) {
			try {
				unlinkSync(file);
			} catch {
				// Ignore errors
			}
		}

		const cacheFiles = await fg(`${workspace}/**/.cache/tsbuildinfo.json`, {
			absolute: true,
		});
		for (const file of cacheFiles) {
			try {
				unlinkSync(file);
			} catch {
				// Ignore errors
			}
		}
	} catch {
		// Ignore errors
	}
}

async function countTypeScriptFiles(
	pkgPath: string,
	root: string,
): Promise<number> {
	const files = await fg(`${pkgPath}/**/*.{ts,tsx}`, {
		cwd: root,
		ignore: ["**/node_modules/**"],
	});
	return files.length;
}

function formatErrorOutput(output: string): string {
	return output
		.split("\n")
		.map((line) => {
			return line
				.replace(/\.\.\/\.\.\/packages\/modules\//g, "")
				.replace(/\((\d+),(\d+)\):?/g, ":$1:$2 -");
		})
		.join("\n")
		.trim();
}

function workspaceLabel(workspace: string, fileCount: number): string {
	return fileCount > 0 ? `${workspace} (${fileCount} files)` : workspace;
}

async function runSingleTypecheck(
	{ path: workspace, fileCount, command }: Workspace,
	root: string,
	verbose: boolean,
	isRetry = false,
): Promise<WorkspaceTypecheckResult> {
	const startTime = performance.now();
	if (verbose) {
		console.log(
			`Running typecheck in ${workspaceLabel(workspace, fileCount)}${isRetry ? " (retry)" : ""}...`,
		);
	}

	const workspacePath = join(root, workspace);
	const result = await execAsync(
		command ?? [process.execPath, "run", "typecheck"],
		workspacePath,
		{},
		{
			throwOnError: false,
		},
	);

	const duration = Number(((performance.now() - startTime) / 1000).toFixed(2));
	const success = result.exitCode === 0;

	let errorOutput: string | undefined;
	if (!success) {
		const parts = [result.stdout.trim(), result.stderr.trim()].filter(Boolean);
		errorOutput = parts.length > 0 ? parts.join("\n") : undefined;

		if (!isRetry && errorOutput && isCorruptedCacheError(errorOutput)) {
			await clearTsBuildInfo(workspacePath, verbose);
			return runSingleTypecheck(
				{ path: workspace, fileCount, command },
				root,
				verbose,
				true,
			);
		}
	}

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
				: await fg(pattern, {
						cwd: root,
						onlyDirectories: true,
						ignore: ["**/node_modules/**"],
					});
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
						message: error instanceof Error ? error.message : String(error),
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
async function excludedPaths(
	exclude: readonly string[],
	root: string,
	workspaces: readonly Workspace[],
): Promise<Set<string>> {
	const excluded = new Set<string>();
	if (exclude.length === 0) return excluded;
	const patterns = exclude.map((entry) =>
		entry.replace(/^\.\//, "").replace(/\/$/, ""),
	);
	for (const path of await fg(patterns, {
		cwd: root,
		onlyDirectories: true,
		ignore: ["**/node_modules/**"],
	}))
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
	timings: Readonly<Record<string, number>>,
	selection: { include?: readonly string[]; exclude?: readonly string[] } = {},
): Promise<{ workspaces: Workspace[]; problems: IncludeProblem[] }> {
	const matches = await fg(
		patterns.map((pattern) => `${pattern.replace(/\/$/, "")}/package.json`),
		{ cwd: root, ignore: ["**/node_modules/**"] },
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

	const excluded = await excludedPaths(
		selection.exclude ?? [],
		root,
		candidates,
	);
	const workspaces = await Promise.all(
		candidates
			.filter((workspace) => !excluded.has(workspace.path))
			.map(async (workspace) => ({
				...workspace,
				fileCount: await countTypeScriptFiles(workspace.path, root),
			})),
	);

	return {
		workspaces: sortWorkspacesByExpectedDuration(workspaces, timings),
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
		includeRootConfig = true,
		only,
		include,
		exclude,
	} = options;
	const concurrency = options.concurrency ?? defaultTypecheckConcurrency();

	const totalStartTime = performance.now();

	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new Error("typecheck concurrency must be a positive integer");
	}
	const patterns = workspacePatterns(root, overridePatterns);
	let rootConfig: ConfigTypecheckResult | undefined;

	const timings = await readTypecheckTimings(root);
	const discovered = await discoverWorkspaces(patterns, root, timings, {
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
				totalDuration: Number(
					((performance.now() - totalStartTime) / 1000).toFixed(2),
				),
				totalFiles: 0,
				workspaceCount: 0,
				results: [],
				selectionError,
			};
		}
		workspaces = selected;
	}

	if (workspaces.length === 0) {
		const rootConfig = includeRootConfig
			? await typecheckRootConfig({ root, verbose: false })
			: undefined;
		if (verbose) {
			if (rootConfig) logRootConfigResult(rootConfig, verbose);
			console.log("No workspaces with typecheck script found.");
		}
		return {
			success: (rootConfig?.success ?? true) && problemResults.length === 0,
			totalDuration: Number(
				((performance.now() - totalStartTime) / 1000).toFixed(2),
			),
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
	const running = new Set<Promise<void>>();

	if (includeRootConfig) {
		const rootJob = typecheckRootConfig({ root, verbose: false }).then(
			(result) => {
				rootConfig = result;
				running.delete(rootJob);
				logRootConfigResult(result, verbose);
			},
		);
		running.add(rootJob);
	}

	for (let i = 0; i < workspaces.length; i++) {
		while (running.size >= concurrency) await Promise.race(running);
		const workspace = workspaces[i];
		if (!workspace) continue;
		const promise = runSingleTypecheck(workspace, root, verbose).then(
			(result) => {
				results[i] = result;
				running.delete(promise);
				logWorkspaceResult(result, verbose);
			},
		);

		running.add(promise);

		if (running.size >= concurrency) {
			await Promise.race(running);
		}
	}

	await Promise.all(running);

	await writeTypecheckTimings(root, timings, results);

	const totalDuration = Number(
		((performance.now() - totalStartTime) / 1000).toFixed(2),
	);
	const totalFiles = workspaces.reduce((sum, w) => sum + w.fileCount, 0);
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
