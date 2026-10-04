import { isHostsForcedOff } from "../../core/runtime-flags";
import { createNoopPhaseTimer, createPhaseTimer } from "../../core/timing";
import { exitOnDevArgErrors, parseDevArgs, printDevHelp } from "../dev-flags";
import { getFlagValue, hasFlag, splitCliArgs } from "../flags";
import * as log from "../log";
import { parseTypecheckArgs, printTypecheckHelp } from "../typecheck-flags";

export function getEnvDotPath(
	snapshot: Record<string, unknown>,
	path: string,
): unknown {
	let current: unknown = snapshot;
	for (const part of path.split(".").filter(Boolean)) {
		if (
			current === null ||
			current === undefined ||
			typeof current !== "object"
		) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/** `export NAME='value'` lines a shell can `eval`, quoted so nothing expands. */
export function formatEnvExports(vars: Record<string, string>): string {
	return Object.entries(vars)
		.map(
			([name, value]) => `export ${name}='${value.replaceAll("'", "'\\''")}'`,
		)
		.join("\n");
}

export function formatEnvDotValue(value: unknown): string {
	if (value === undefined) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return JSON.stringify(value);
}

export async function loadEnv(
	options: { containerRuntime?: string; readOnly?: boolean } = {},
) {
	try {
		return await (await import("../../loader")).loadDevEnv(options);
	} catch (error) {
		log.fail(error instanceof Error ? error.message : String(error));
	}
}

export async function handleDev(args: string[]): Promise<void> {
	const parsed = parseDevArgs(args);
	// Help comes from the flag spec, so it must not require a config file.
	if (parsed.help) {
		printDevHelp();
		return;
	}
	exitOnDevArgErrors(parsed);
	// The runtime has to be known before the environment is built, so it is read
	// here rather than inside runCli, which is handed a finished env.
	const timer = parsed.timing
		? createPhaseTimer({ startedAt: 0, json: parsed.timingJson })
		: createNoopPhaseTimer();
	try {
		const env = await timer.measure("config and ports", async () =>
			(await import("../../loader")).loadDevEnv({
				containerRuntime: parsed.runtime,
			}),
		);
		await (await import("../run-cli")).runCli(env, { args, timer });
	} catch (error) {
		timer.report();
		throw error;
	}
}

export async function handlePrisma(args: string[]): Promise<void> {
	// Parsed before the config loads, so a typo is not answered with a config error.
	const migrateCheck =
		args[0] === "migrate-check"
			? parseMigrateCheckArgs(args.slice(1))
			: undefined;
	const env = await loadEnv();

	if (!env.prisma) {
		log.fail("Prisma is not configured in your dev config.", [
			"Add prisma to your config:",
			"",
			"export default defineDevConfig({",
			"  ...",
			"  prisma: { cwd: 'packages/prisma' }",
			"})",
		]);
	}

	const exitCode = migrateCheck
		? await env.prisma.migrateCheck(migrateCheck)
		: await env.prisma.run(args);
	process.exit(exitCode);
}

/** `migrate-check [--migrations=<dir>] [--schema=<path>] [-- <diff args>]` */
function parseMigrateCheckArgs(args: string[]) {
	const { flags, passthrough } = splitCliArgs(args);
	const unknown = flags.filter(
		(flag) =>
			!flag.startsWith("--migrations=") && !flag.startsWith("--schema="),
	);
	if (unknown.length > 0) {
		log.fail(`Unexpected argument: ${unknown.join(" ")}`, [
			"Usage: buncargo prisma migrate-check [--migrations=<dir>] [--schema=<path>] [-- <prisma migrate diff args>]",
		]);
	}

	return {
		migrations: getFlagValue(flags, "--migrations") || undefined,
		schema: getFlagValue(flags, "--schema") || undefined,
		args: passthrough,
	};
}

/**
 * The environment as this checkout's live run sees it: the named URLs the
 * daemon is actually serving, and what the run's apps printed.
 */
export async function loadLiveEnv() {
	const { getCaPath, waitForDaemonRoutes } = await import("../../core/hosts");
	const { adoptLiveCaptures } = await import("../run-publish");
	const env = await loadEnv({ readOnly: true });
	// A healthy daemon is not the same as a daemon serving this project: a
	// `vite.config.ts` reading `urls.web` from here must not be handed an https
	// hostname the proxy would 404. Zero wait — this only reports state, so an
	// unpicked-up route reads as localhost rather than blocking the command.
	if (env.hosts && env.hosts.plan.length > 0 && !isHostsForcedOff()) {
		const serving = await waitForDaemonRoutes(
			env.hosts.plan.map((entry) => entry.hostname),
			{ timeoutMs: 0 },
		);
		if (serving.ok) {
			env.setNamedHostsActive(true, { caPath: getCaPath() });
		}
	}
	await adoptLiveCaptures(env);
	return env;
}

export async function handleEnv(args: string[] = []): Promise<void> {
	const env = await loadLiveEnv();
	const snapshot = {
		projectName: env.projectName,
		ports: env.ports,
		urls: env.urls,
		loopbackUrls: env.loopbackUrls,
		portOffset: env.portOffset,
		portOffsetProvenance: env.portOffsetProvenance,
		isWorktree: env.isWorktree,
		localIp: env.localIp,
		root: env.root,
		captured: env.captured,
		details: env.details(),
		hosts: env.hosts
			? {
					active: env.hosts.active,
					tld: env.hosts.tld,
					plan: env.hosts.plan,
				}
			: null,
		// What `exec`, tasks and the apps are given (without their secrets),
		// so `DATABASE_URL` can be read rather than reassembled from ports.
		vars: env.buildEnvVars() as Record<string, string>,
	};
	if (hasFlag(args, "--export")) {
		log.line(formatEnvExports(snapshot.vars));
		return;
	}
	const getPath = getFlagValue(args, "--get");
	if (getPath !== undefined) {
		if (getPath === "") {
			log.fail("Flag --get requires a dot path (e.g. ports.api).");
		}
		// A bare variable name (`--get DATABASE_URL`) reads from `vars`.
		const value =
			getEnvDotPath(snapshot as Record<string, unknown>, getPath) ??
			(getPath.includes(".") ? undefined : snapshot.vars[getPath]);
		if (value === undefined) {
			log.fail(`Unknown env path: ${getPath}`);
		}
		log.line(formatEnvDotValue(value));
		return;
	}
	log.line(JSON.stringify(snapshot, null, 2));
}

export async function handleTypecheck(args: string[] = []): Promise<void> {
	const parsed = parseTypecheckArgs(args);
	if (parsed.help) {
		printTypecheckHelp();
		return;
	}
	if (parsed.unknownFlags.length > 0) {
		log.fail(
			`Unknown flag${parsed.unknownFlags.length > 1 ? "s" : ""}: ${parsed.unknownFlags.join(", ")}`,
			['Run "bunx buncargo typecheck --help" for typecheck options.'],
		);
	}
	if (parsed.errors.length > 0) {
		log.fail(parsed.errors[0] ?? "Invalid typecheck arguments.");
	}

	const { runWorkspaceTypecheck } = await import("../../typecheck");
	const result = await runWorkspaceTypecheck({
		root: (await import("../../core/ports")).findMonorepoRoot(),
		verbose: true,
		concurrency: parsed.concurrency,
		only: parsed.only,
	});
	process.exit(result.success ? 0 : 1);
}
