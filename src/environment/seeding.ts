import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withDeadline } from "../core/deadline";
import { toUrlMap, type UrlMap } from "../core/ports";
import { type ExecResult, execAsync } from "../core/process";
import { formatDone, formatFail, formatStep, formatWarn } from "../core/style";
import { resolvePrismaConfig } from "../prisma/config";
import type {
	AppConfig,
	EnvValues,
	HookContext,
	SeedCheckContext,
	SeedOutcome,
	SeedRunOptions,
	ServiceConfig,
} from "../types";
import type { DevEnvContext, StartSelection } from "./context";
import type { DevEnvVarsApi } from "./env-vars";

const BUN_SCRIPT_COMMAND =
	/^bun\s+(?:run\s+)?((?:\.\.?\/)?[\w./-]+\.(?:ts|js|mts|cts|tsx|jsx))$/;

export function resolveBunSeedSpecifier(command: string): string | undefined {
	return command.trim().match(BUN_SCRIPT_COMMAND)?.[1];
}

/** How many of a failed seed's last lines it reports. */
export const SEED_TAIL_LINES = 20;

function lastLines(text: string): string[] {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.slice(-SEED_TAIL_LINES);
}

export async function runSeedCommand(input: {
	command: string;
	signal?: AbortSignal;
	root: string;
	cwd?: string;
	envVars: Record<string, string>;
	forceExit?: boolean;
	verbose?: boolean;
	prefixOutput?: boolean;
	onOutputLine?: (line: string) => void;
}): Promise<ExecResult> {
	const specifier = resolveBunSeedSpecifier(input.command);
	const forceExit = input.forceExit ?? Boolean(specifier);
	const workingDir = input.cwd ? resolve(input.root, input.cwd) : input.root;

	if (forceExit && specifier) {
		const href = pathToFileURL(resolve(workingDir, specifier)).href;
		const wrapped = `await import(${JSON.stringify(href)}); process.exit(process.exitCode ?? 0)`;
		return execAsync(
			[process.execPath, "--eval", wrapped],
			input.root,
			input.envVars,
			{
				cwd: input.cwd,
				verbose: input.verbose,
				outputPrefix: input.prefixOutput ? "seed" : undefined,
				onOutputLine: input.onOutputLine,
				throwOnError: false,
				signal: input.signal,
				timeoutMs: 600_000,
			},
		);
	}

	return execAsync(input.command, input.root, input.envVars, {
		cwd: input.cwd,
		verbose: input.verbose,
		outputPrefix: input.prefixOutput ? "seed" : undefined,
		onOutputLine: input.onOutputLine,
		throwOnError: false,
		signal: input.signal,
		timeoutMs: 600_000,
	});
}

export function createCheckTableHelper<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	urls: UrlMap,
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
			console.warn(
				formatWarn(`Service "${serviceName}" not found for checkTable`),
			);
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
			console.log(formatStep(`📊 Table "${tableName}" has ${count} rows`));
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
	TEnv extends EnvValues = EnvValues,
>(
	ctx: DevEnvContext<TServices, TApps, TEnv>,
	envVars: DevEnvVarsApi<TServices, TApps, TEnv>,
	options: SeedRunOptions = {},
	selection?: StartSelection,
): Promise<SeedOutcome> {
	const seed = ctx.config.seed;
	if (!seed) {
		return { status: "not-configured" };
	}
	const { verbose = true, productionBuild = false, force = false } = options;

	const seedCheck = seed.check;
	if (seedCheck && !force) {
		const shouldSeed = await withDeadline(
			async (signal) => {
				const checkTable = createCheckTableHelper<TServices, TApps>(
					toUrlMap(ctx.urls),
					(cmd, execOptions) =>
						envVars.exec(cmd, { ...execOptions, signal, timeoutMs: 600_000 }),
					resolvePrismaConfig(ctx.config.prisma).service,
				);
				return seedCheck(
					createSeedCheckContext(
						envVars.getHookContext(signal, selection),
						checkTable,
					),
				);
			},
			600_000,
			options.signal,
		);
		if (!shouldSeed) {
			if (verbose)
				console.log(formatDone("Database already has data, skipping seeders"));
			return { status: "not-needed" };
		}
	}

	if (verbose) console.log(formatStep("🌱 Running seeders..."));
	const computed: Record<string, string> =
		envVars.buildEnvVars(productionBuild);
	const secrets = await envVars.resolveSecrets(seed.secrets, {
		signal: options.signal,
		computed,
	});
	// The last lines, in order, for a failure to show at the end. Read line by
	// line unless they go straight to a terminal, where they stay visible and
	// keep their colours and redraws.
	const tail: string[] = [];
	const keep = (line: string) => {
		tail.push(line);
		if (tail.length > SEED_TAIL_LINES) tail.shift();
	};
	const toTerminal =
		verbose && !options.prefixOutput && process.stdout.isTTY === true;
	const printLine =
		verbose && !options.prefixOutput && !toTerminal
			? (line: string) => console.log(line)
			: undefined;
	const sink = options.onOutputLine ?? printLine;
	const onOutputLine =
		sink &&
		((line: string) => {
			sink(line);
			keep(line);
		});
	const result = await runSeedCommand({
		command: seed.command,
		signal: options.signal,
		root: ctx.root,
		cwd: seed.cwd,
		// Secrets beneath the computed env, as for every other process.
		envVars: { ...secrets, ...computed },
		forceExit: seed.forceExit,
		prefixOutput: options.prefixOutput,
		onOutputLine,
		verbose,
	});

	if (result.exitCode !== 0) {
		console.error(formatFail("Seeding failed"));
		// Already shown when its output was streamed.
		const streamed =
			verbose && (options.prefixOutput || onOutputLine !== undefined);
		if (!streamed) console.error(result.stderr);
		// Prefixed or quiet output was collected whole rather than line by line.
		if (tail.length === 0)
			tail.push(...lastLines(`${result.stdout}${result.stderr}`));
		return { status: "failed", result, command: seed.command, tail };
	}

	if (verbose) console.log(formatDone("Seeding complete"));
	return { status: "succeeded", result };
}
