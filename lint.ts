import { execSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import fg from "fast-glob";

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
	/** Maximum concurrent typecheck processes (defaults to 1) */
	concurrency?: number;
	/** Print output to console (defaults to true) */
	verbose?: boolean;
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
}

interface Workspace {
	path: string;
	fileCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_PATTERNS = ["apps/*", "packages/*", "modules"];
const DEFAULT_CONCURRENCY = 1;

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
			`Running typecheck in ${workspace} (${fileCount} files)${isRetry ? " (retry)" : ""}...`,
		);
	}

	const workspacePath = join(root, workspace);

	let success = false;
	let stdout = "";
	let stderr = "";

	try {
		const output = execSync("bun run typecheck", {
			cwd: workspacePath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		stdout = output ?? "";
		success = true;
	} catch (error) {
		const execError = error as {
			status?: number;
			stdout?: string;
			stderr?: string;
		};
		stdout = execError.stdout ?? "";
		stderr = execError.stderr ?? "";
		success = false;
	}

	const duration = Number(((performance.now() - startTime) / 1000).toFixed(2));

	let errorOutput: string | undefined;
	if (!success) {
		const parts = [stdout.trim(), stderr.trim()].filter(Boolean);
		errorOutput = parts.length > 0 ? parts.join("\n") : undefined;

		// Check for corrupted cache and retry once
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
): Promise<Workspace[]> {
	const workspaces: Workspace[] = [];

	for (const pattern of patterns) {
		const matches = await fg(`${pattern}/package.json`, { cwd: root });
		for (const match of matches) {
			const pkgPath = match.replace("/package.json", "");
			try {
				const pkgJsonContent = readFileSync(join(root, match), "utf-8");
				const pkgJson = JSON.parse(pkgJsonContent);
				if (pkgJson.scripts?.typecheck) {
					const fileCount = await countTypeScriptFiles(pkgPath, root);
					workspaces.push({ path: pkgPath, fileCount });
				}
			} catch {
				// Skip invalid package.json files
			}
		}
	}

	// Sort by file count (smallest first for faster feedback)
	workspaces.sort((a, b) => a.fileCount - b.fileCount);

	return workspaces;
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
		concurrency = DEFAULT_CONCURRENCY,
		verbose = true,
	} = options;

	// Discover workspaces
	const workspaces = await discoverWorkspaces(patterns, root);

	if (workspaces.length === 0) {
		if (verbose) {
			console.log("No workspaces with typecheck script found.");
		}
		return {
			success: true,
			totalDuration: 0,
			totalFiles: 0,
			workspaceCount: 0,
			results: [],
		};
	}

	const totalStartTime = performance.now();
	if (verbose) {
		console.log(
			`Running typecheck across ${workspaces.length} workspaces with concurrency limit of ${concurrency}...\n`,
		);
	}

	const results: WorkspaceTypecheckResult[] = [];
	const running = new Set<Promise<void>>();

	for (let i = 0; i < workspaces.length; i++) {
		const { path, fileCount } = workspaces[i];
		const promise = runSingleTypecheck(path, fileCount, root, verbose).then(
			(result) => {
				results[i] = result;
				running.delete(promise);

				if (verbose) {
					const icon = result.success ? "✅" : "❌";
					const log = result.success ? console.log : console.error;
					log(
						`${icon} ${result.workspace} (${result.fileCount} files) ${result.success ? "completed" : "failed"} in ${result.duration.toFixed(2)}s`,
					);
					if (!result.success && result.errorOutput) {
						console.error(`\n${formatErrorOutput(result.errorOutput)}`);
					}
				}
			},
		);

		running.add(promise);

		if (running.size >= concurrency) {
			await Promise.race(running);
		}
	}

	await Promise.all(running);

	const totalDuration = Number(
		((performance.now() - totalStartTime) / 1000).toFixed(2),
	);
	const totalFiles = workspaces.reduce((sum, w) => sum + w.fileCount, 0);
	const success = results.every((r) => r.success);

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
	};
}
