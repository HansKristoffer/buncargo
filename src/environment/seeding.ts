import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ExecResult, execAsync } from "../core/process";
import type {
	AppConfig,
	HookContext,
	SeedCheckContext,
	SeedOutcome,
	SeedRunOptions,
	ServiceConfig,
} from "../types";
import type { DevEnvContext } from "./context";
import type { DevEnvVarsApi } from "./env-vars";

const BUN_SCRIPT_COMMAND =
	/^bun\s+(?:run\s+)?((?:\.\.?\/)?[\w./-]+\.(?:ts|js|mts|cts|tsx|jsx))$/;

export function resolveBunSeedSpecifier(command: string): string | undefined {
	return command.trim().match(BUN_SCRIPT_COMMAND)?.[1];
}

export async function runSeedCommand(input: {
	command: string;
	root: string;
	cwd?: string;
	envVars: Record<string, string>;
	forceExit?: boolean;
	verbose?: boolean;
}): Promise<ExecResult> {
	const specifier = resolveBunSeedSpecifier(input.command);
	const forceExit = input.forceExit ?? Boolean(specifier);
	const workingDir = input.cwd ? resolve(input.root, input.cwd) : input.root;

	if (forceExit && specifier) {
		const href = pathToFileURL(resolve(workingDir, specifier)).href;
		const wrapped = `await import(${JSON.stringify(href)}); process.exit(process.exitCode ?? 0)`;
		return execAsync(
			`bun --eval ${JSON.stringify(wrapped)}`,
			input.root,
			input.envVars,
			{
				cwd: input.cwd,
				verbose: input.verbose,
				throwOnError: false,
			},
		);
	}

	return execAsync(input.command, input.root, input.envVars, {
		cwd: input.cwd,
		verbose: input.verbose,
		throwOnError: false,
	});
}

export function createCheckTableHelper<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	urls: Record<string, string>,
	exec: (
		cmd: string,
		options?: { throwOnError?: boolean },
	) => Promise<{
		exitCode: number;
		stdout: string;
		stderr: string;
	}>,
	defaultService = "postgres",
): SeedCheckContext<TServices, TApps>["checkTable"] {
	return async (
		tableName: string,
		service?: keyof TServices,
	): Promise<boolean> => {
		const serviceName = (service ?? defaultService) as string;
		const serviceUrl = urls[serviceName];
		if (!serviceUrl) {
			console.warn(`⚠️ Service "${serviceName}" not found for checkTable`);
			return true;
		}
		const checkResult = await exec(
			`psql "${serviceUrl}" -tAc 'SELECT COUNT(*) FROM "${tableName}" LIMIT 1'`,
			{ throwOnError: false },
		);
		const count = checkResult.stdout.trim();
		const shouldSeed =
			checkResult.exitCode !== 0 || count === "0" || count === "";
		if (!shouldSeed) {
			console.log(`  📊 Table "${tableName}" has ${count} rows`);
		}
		return shouldSeed;
	};
}

export function createSeedCheckContext<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	baseContext: HookContext<TServices, TApps>,
	checkTable: SeedCheckContext<TServices, TApps>["checkTable"],
): SeedCheckContext<TServices, TApps> {
	return {
		...baseContext,
		checkTable,
	};
}

/**
 * The single seed path, used by both `start()` and `buncargo dev --seed`:
 * consult `seed.check`, then run `seed.command`.
 *
 * Returns the outcome instead of throwing or exiting so each caller decides
 * how a failed seed should affect it.
 */
export async function runSeedIfNeeded<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	ctx: DevEnvContext<TServices, TApps>,
	envVars: DevEnvVarsApi<TServices, TApps>,
	options: SeedRunOptions = {},
): Promise<SeedOutcome> {
	const seed = ctx.config.seed;
	if (!seed) {
		return { status: "not-configured" };
	}
	const { verbose = true, productionBuild = false, force = false } = options;

	if (seed.check && !force) {
		const checkTable = createCheckTableHelper<TServices, TApps>(
			ctx.urls as Record<string, string>,
			envVars.exec,
			ctx.config.prisma?.service ?? "postgres",
		);
		const shouldSeed = await seed.check(
			createSeedCheckContext(envVars.getHookContext(), checkTable),
		);
		if (!shouldSeed) {
			if (verbose) console.log("✓ Database already has data, skipping seeders");
			return { status: "not-needed" };
		}
	}

	if (verbose) console.log("🌱 Running seeders...");
	const result = await runSeedCommand({
		command: seed.command,
		root: ctx.root,
		cwd: seed.cwd,
		envVars: envVars.buildEnvVars(productionBuild),
		forceExit: seed.forceExit,
		verbose,
	});

	if (result.exitCode !== 0) {
		console.error("❌ Seeding failed");
		console.error(result.stderr);
		return { status: "failed", result };
	}

	if (verbose) console.log("✓ Seeding complete");
	return { status: "succeeded", result };
}
