import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import fg from "fast-glob";
import { execAsync } from "../core/process";
import { CONFIG_FILES } from "../loader";

/**
 * Result of typechecking the root dev config.
 */
export interface ConfigTypecheckResult {
	/** Config file that was checked, relative to the root, or null if none exists */
	configFile: string | null;
	success: boolean;
	duration: number;
	errorOutput?: string;
}

/**
 * Where the generated tsconfig lands. Inside the repo so that `node_modules`,
 * `typeRoots` and any `extends` target resolve the way they would for a
 * hand-written config.
 */
const GENERATED_TSCONFIG = join(".buncargo", "config-typecheck.tsconfig.json");

/**
 * Options the generated tsconfig uses when the repo has no root `tsconfig.json`
 * to extend.
 *
 * Deliberately does not set `types`: naming `["bun"]` would fail outright on a
 * repo without `@types/bun`, whereas the default (every package under
 * `node_modules/@types`) works everywhere.
 */
const FALLBACK_COMPILER_OPTIONS = {
	target: "esnext",
	module: "preserve",
	moduleResolution: "bundler",
	strict: true,
	skipLibCheck: true,
	allowImportingTsExtensions: true,
	resolveJsonModule: true,
} as const;

function findRootConfigFile(root: string): string | null {
	for (const file of CONFIG_FILES) {
		if (existsSync(join(root, file))) return file;
	}
	return null;
}

/**
 * Prefer the project's own `tsc`. `bunx tsc` with no local TypeScript downloads
 * whatever is latest on npm (today, 7.x) and that compiler rejects `process`
 * unless `types` names `node` — which is how a perfectly valid `dev.config.ts`
 * failed the first time this check ran in a monorepo that only installs
 * TypeScript inside workspaces.
 */
async function resolveProjectTsc(root: string): Promise<string> {
	let current = root;
	while (true) {
		const candidate = join(current, "node_modules", "typescript", "bin", "tsc");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	const workspaceCopies = await fg(
		[
			"apps/*/node_modules/typescript/bin/tsc",
			"packages/*/node_modules/typescript/bin/tsc",
			"modules/node_modules/typescript/bin/tsc",
		],
		{
			cwd: root,
			absolute: true,
			ignore: ["**/node_modules/**/node_modules/**"],
		},
	);
	if (workspaceCopies[0]) return workspaceCopies[0];

	return "bunx tsc";
}

/**
 * Write the tsconfig used to check the config file on its own.
 *
 * `files` is a single entry so the program is exactly the config plus whatever
 * it imports. When the repo has a root `tsconfig.json` we extend it, since a
 * config that relies on `paths` aliases or `verbatimModuleSyntax` would
 * otherwise fail for reasons that have nothing to do with buncargo.
 */
function writeGeneratedTsconfig(root: string, configFile: string): string {
	const tsconfigPath = join(root, GENERATED_TSCONFIG);
	mkdirSync(join(root, ".buncargo"), { recursive: true });

	const hasRootTsconfig = existsSync(join(root, "tsconfig.json"));
	const tsconfig = {
		...(hasRootTsconfig ? { extends: "../tsconfig.json" } : {}),
		compilerOptions: {
			...(hasRootTsconfig ? {} : FALLBACK_COMPILER_OPTIONS),
			noEmit: true,
			// A shared tsbuildinfo would make this check skip its own input.
			incremental: false,
		},
		files: [join("..", configFile)],
	};

	writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, "\t")}\n`);
	return tsconfigPath;
}

/**
 * Typecheck the root dev config.
 *
 * The config sits at the repo root, so it belongs to no workspace and
 * {@link runWorkspaceTypecheck} never reaches it. That blind spot is the reason
 * a config can lose its `defineDevConfig` inference — or stop matching the
 * installed buncargo entirely — without any check failing.
 *
 * Returns a passing result when the repo has no config file, so this is safe to
 * call unconditionally.
 */
export async function typecheckRootConfig(options: {
	root: string;
	verbose?: boolean;
}): Promise<ConfigTypecheckResult> {
	const { root, verbose = true } = options;
	const configFile = findRootConfigFile(root);

	if (!configFile) {
		return { configFile: null, success: true, duration: 0 };
	}

	const startTime = performance.now();
	if (verbose) {
		console.log(`Running typecheck on ${configFile}...`);
	}

	let tsconfigPath: string;
	try {
		tsconfigPath = writeGeneratedTsconfig(root, configFile);
	} catch (error) {
		return {
			configFile,
			success: false,
			duration: 0,
			errorOutput: `Could not write ${GENERATED_TSCONFIG}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	let success = false;
	let errorOutput: string | undefined;

	const tsc = await resolveProjectTsc(root);
	const command =
		tsc === "bunx tsc"
			? `bunx tsc -p ${JSON.stringify(tsconfigPath)}`
			: `${JSON.stringify(tsc)} -p ${JSON.stringify(tsconfigPath)}`;
	const result = await execAsync(command, root, {}, { throwOnError: false });
	success = result.exitCode === 0;
	if (!success) {
		const parts = [result.stdout.trim(), result.stderr.trim()].filter(Boolean);
		errorOutput = parts.length > 0 ? parts.join("\n") : undefined;
	}

	const duration = Number(((performance.now() - startTime) / 1000).toFixed(2));
	return { configFile, success, duration, errorOutput };
}
