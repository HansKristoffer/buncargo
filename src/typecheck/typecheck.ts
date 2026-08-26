import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import fg from "fast-glob";
import { execAsync } from "../core/process";
import {
	type ConfigTypecheckResult,
	typecheckRootConfig,
} from "./config-typecheck";
import {
	defaultTypecheckConcurrency,
	selectWorkspaces,
	sortWorkspacesByExpectedDuration,
} from "./scheduling";
import { readTypecheckTimings, writeTypecheckTimings } from "./timings";

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
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_PATTERNS = ["apps/*", "packages/*", "modules"];

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
	workspace: string,
	fileCount: number,
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
		"bun run typecheck",
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
			return runSingleTypecheck(workspace, fileCount, root, verbose, true);
		}
	}

	return { workspace, duration, success, fileCount, errorOutput };
}

async function discoverWorkspaces(
	patterns: string[],
	root: string,
	timings: Readonly<Record<string, number>>,
): Promise<Workspace[]> {
	const matchLists = await Promise.all(
		patterns.map((pattern) => fg(`${pattern}/package.json`, { cwd: root })),
	);

	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const matches of matchLists) {
		for (const match of matches) {
			const pkgPath = match.replace("/package.json", "");
			if (seen.has(pkgPath)) continue;
			seen.add(pkgPath);
			try {
				const pkgJson = JSON.parse(
					readFileSync(join(root, match), "utf-8"),
				) as { scripts?: { typecheck?: string } };
				if (pkgJson.scripts?.typecheck) {
					candidates.push(pkgPath);
				}
			} catch {
				// Skip invalid package.json files
			}
		}
	}

	const workspaces = await Promise.all(
		candidates.map(async (path) => {
			const fileCount =
				timings[path] === undefined
					? await countTypeScriptFiles(path, root)
					: 0;
			return { path, fileCount };
		}),
	);

	return sortWorkspacesByExpectedDuration(workspaces, timings);
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
		patterns = DEFAULT_PATTERNS,
		verbose = true,
		includeRootConfig = true,
		only,
	} = options;
	const concurrency = options.concurrency ?? defaultTypecheckConcurrency();

	const totalStartTime = performance.now();

	// Kick the root config off immediately so it overlaps discovery + the pool.
	const rootConfigPromise = includeRootConfig
		? typecheckRootConfig({ root, verbose: false })
		: undefined;

	const timings = await readTypecheckTimings(root);
	let workspaces = await discoverWorkspaces(patterns, root, timings);

	if (only && only.length > 0) {
		const { selected, unknown } = selectWorkspaces(workspaces, only);
		if (unknown.length > 0) {
			const known = workspaces.map((workspace) => workspace.path);
			const selectionError = `Unknown workspace${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Known: ${known.join(", ") || "(none)"}`;
			if (verbose) {
				console.error(selectionError);
			}
			if (rootConfigPromise) {
				await rootConfigPromise;
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
		const rootConfig = await rootConfigPromise;
		if (verbose) {
			if (rootConfig) logRootConfigResult(rootConfig, verbose);
			console.log("No workspaces with typecheck script found.");
		}
		return {
			success: rootConfig?.success ?? true,
			totalDuration: Number(
				((performance.now() - totalStartTime) / 1000).toFixed(2),
			),
			totalFiles: 0,
			workspaceCount: 0,
			results: [],
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

	for (let i = 0; i < workspaces.length; i++) {
		const workspace = workspaces[i];
		if (!workspace) continue;
		const { path, fileCount } = workspace;
		const promise = runSingleTypecheck(path, fileCount, root, verbose).then(
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

	const [rootConfig] = await Promise.all([
		rootConfigPromise,
		Promise.all(running),
	]);

	if (rootConfig) {
		logRootConfigResult(rootConfig, verbose);
	}

	await writeTypecheckTimings(root, timings, results);

	const totalDuration = Number(
		((performance.now() - totalStartTime) / 1000).toFixed(2),
	);
	const totalFiles = workspaces.reduce((sum, w) => sum + w.fileCount, 0);
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
