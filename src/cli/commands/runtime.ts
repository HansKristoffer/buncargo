import { join, relative } from "node:path";
import { getErrorMessage } from "hanzio";
import { readEnvOverrides } from "../../core/env-overrides";
import { unallocatedPortsMessage } from "../../core/port-exhaustion";
import { CommandSignalError, shellExitCode } from "../../core/process/exec";
import { isInteractive } from "../../core/prompt";
import { detachedRunMode, isCI } from "../../core/runtime-flags";
import { createNoopPhaseTimer, createPhaseTimer } from "../../core/timing";
import { WATCHDOG_IDLE_TIMEOUT_MS } from "../../core/watchdog-constants";
import type { AnyDevEnvironment, PrismaRunner } from "../../types";
import { exitOnDevArgErrors, parseDevArgs, printDevHelp } from "../dev-flags";
import { CliError } from "../errors";
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
		log.fail(getErrorMessage(error));
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
	// The background run loads the config and builds the environment; this
	// process only starts it and waits. One already in the background is
	// refused by `runCli`.
	if (parsed.detach && detachedRunMode() === undefined) {
		const { findCheckoutRoot } = await import("../../loader/find-config-file");
		const root = findCheckoutRoot(process.cwd());
		if (root === undefined)
			log.fail(
				"No config file found. Create dev.config.ts with: export default defineDevConfig({ ... })",
			);
		for (const warning of parsed.ignoredFlags) log.warn(warning);
		const { DETACH_TIMEOUT_MS, runDetached } = await import("../dev-detach");
		process.exit(
			await runDetached({
				root,
				keep: parsed.keep,
				argv: process.argv,
				timeoutMs: DETACH_TIMEOUT_MS,
			}),
		);
	}
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

export async function handlePrisma(rawArgs: string[]): Promise<void> {
	// `--yes` and `--db` are buncargo's, not Prisma's.
	const yes = rawArgs.includes("--yes");
	const db = getFlagValue(rawArgs, "--db");
	const args = rawArgs.filter(
		(arg) => arg !== "--yes" && arg !== "--db" && !arg.startsWith("--db="),
	);
	if (db === "") log.fail("--db takes a database name: --db=scratch_<name>");
	// Parsed before the config loads, so a typo is not answered with a config error.
	const migrateCheck =
		args[0] === "migrate-check"
			? parseMigrateCheckArgs(args.slice(1))
			: undefined;
	const migration =
		args[0] === "migration" ? parseMigrationArgs(args.slice(1)) : undefined;
	if (migration && db !== undefined)
		log.fail("--db cannot be combined with prisma migration.");
	const { destructivePrismaAction } = await import("../../prisma");
	refuseDestructivePrisma(destructivePrismaAction(args), args, {
		yes,
		interactive: isInteractive(),
		ci: isCI(),
		// What a scratch database holds is the caller's own throwaway.
		scratch: db?.startsWith("scratch_") ?? false,
	});
	const env = await loadEnv({ readOnly: migration?.action === "check" });

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
	const { prisma } = env;
	if (args.length === 0) process.exit(await prisma.run(args));
	if (migration?.action === "check")
		process.exit(await checkMigrationChain(env.root, prisma, migration.base));

	const exitCode = await withClaimedDatabase(env, prisma.service, async () => {
		if (migrateCheck) return prisma.migrateCheck(migrateCheck);
		if (migration?.action === "new")
			return createMigration(prisma, migration.name, migration.empty);
		if (db === undefined) return prisma.run(args);
		const { databaseExists, databaseOverrides } =
			await import("./exec-database");
		const overrides = await databaseOverrides(env, undefined, db, {
			exists: databaseExists,
			inherited: process.env,
		});
		return prisma.run(args, { env: overrides });
	});
	process.exit(exitCode);
}

/** `migration new <name> [--empty]`, `migration check [--base=<ref>]` */
function parseMigrationArgs(args: string[]) {
	const [action, ...rest] = args;
	const usage = [
		"Usage: buncargo prisma migration new <name> [--empty]",
		"       buncargo prisma migration check [--base=<ref>]",
	];
	const flags = rest.filter((arg) => arg.startsWith("-"));
	const positional = rest.filter((arg) => !arg.startsWith("-"));
	if (action === "new") {
		const unknown = flags.filter((flag) => flag !== "--empty");
		const [name, ...extra] = positional;
		if (name === undefined || extra.length > 0 || unknown.length > 0)
			log.fail(
				name === undefined
					? "prisma migration new needs a name."
					: `Unexpected argument: ${[...extra, ...unknown].join(" ")}`,
				usage,
			);
		return { action, name, empty: flags.includes("--empty") } as const;
	}
	if (action === "check") {
		const unknown = flags.filter((flag) => !flag.startsWith("--base="));
		if (positional.length > 0 || unknown.length > 0)
			log.fail(
				`Unexpected argument: ${[...positional, ...unknown].join(" ")}`,
				usage,
			);
		const base = getFlagValue(flags, "--base");
		if (base === "") log.fail("--base takes a git ref.", usage);
		return { action, base } as const;
	}
	return log.fail(
		action === undefined
			? "prisma migration needs new or check."
			: `Unknown prisma migration command: ${action}`,
		usage,
	);
}

/** Print the new migration's path, alone on stdout. */
async function createMigration(
	prisma: PrismaRunner,
	name: string,
	empty: boolean,
): Promise<number> {
	const result = await prisma.newMigration(name, { empty });
	if (result.status === "failed") return result.exitCode;
	if (result.status === "unchanged") {
		console.error(
			"❌ The schema has nothing the migrations lack, so no migration was written. Pass --empty for one you write by hand.",
		);
		return 1;
	}
	console.error("✅ Wrote the migration:");
	log.line(result.path);
	return 0;
}

/**
 * Fail when two migrations share a timestamp, or one the base branch lacks
 * sorts before the base's newest: parallel branches produce both, and a
 * database at the base's tip would skip or misorder them.
 */
async function checkMigrationChain(
	root: string,
	prisma: PrismaRunner,
	requestedBase: string | undefined,
): Promise<number> {
	const {
		defaultBaseRef,
		listMigrationFolders,
		migrationChainProblems,
		migrationFoldersAtRef,
	} = await import("../../prisma");
	const dir = join(root, prisma.cwd, prisma.migrations);
	const local = await listMigrationFolders(dir);
	if (local.length === 0) {
		console.error(`✅ No migrations in ${relative(root, dir)}.`);
		return 0;
	}
	const base = requestedBase ?? defaultBaseRef(dir);
	if (base === undefined)
		throw new CliError("Found no base branch to compare the migrations with.", [
			"Name one: buncargo prisma migration check --base=<ref>",
		]);
	const onBase = migrationFoldersAtRef(dir, base);
	if (onBase === undefined)
		throw new CliError(`git cannot read ${base}.`, [
			"Fetch it, or name another: buncargo prisma migration check --base=<ref>",
		]);
	const problems = migrationChainProblems(local, onBase, base);
	if (problems.length === 0) {
		console.error(
			`✅ ${local.length} migration${local.length === 1 ? "" : "s"} in order with ${base}.`,
		);
		return 0;
	}
	for (const problem of problems) console.error(`❌ ${problem}`);
	console.error(
		"   Rename the folder with a timestamp after the newest on the base branch (prisma migration new picks one).",
	);
	return 1;
}

/**
 * Refuse a destructive Prisma action without a terminal unless `--yes`, as
 * `dev --reset` does: an agent "fixing" a migration with `migrate reset` wipes
 * the developer's database. CI is exempt; its databases are disposable.
 */
function refuseDestructivePrisma(
	action: string | undefined,
	args: readonly string[],
	context: {
		yes: boolean;
		interactive: boolean;
		ci: boolean;
		scratch: boolean;
	},
): void {
	const asked =
		context.yes || context.interactive || context.ci || context.scratch;
	if (action === undefined || asked) return;
	throw new CliError(`${action}. Refusing without a terminal.`, [
		`Pass --yes if that is really what you want: buncargo prisma ${args.join(" ")} --yes`,
	]);
}

/**
 * Run `use` with the database claimed and started, as `buncargo run` does for
 * a task's services: the claim comes before the container, so `ls`, `stop`
 * and BuncargoBar see the run and the sweep leaves the database up while
 * `prisma studio` uses it. Released on the way out, Ctrl-C included, into the
 * hold a `dev` run gets.
 */
async function withClaimedDatabase(
	env: AnyDevEnvironment,
	service: string,
	use: () => Promise<number>,
): Promise<number> {
	const controller = new AbortController();
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	// The terminal's Ctrl-C reaches Prisma itself; this process only has to
	// live long enough to release.
	const cancel = (signal: NodeJS.Signals) =>
		controller.abort(new CommandSignalError(signal));
	for (const name of signals) process.on(name, cancel);
	const { signal } = controller;

	console.error(`Starting ${service} for ${env.projectName}…`);
	try {
		await env.prepareStartAsync(undefined, [service], signal);
		await env.claimRun({
			defaultIdleTimeoutMs: WATCHDOG_IDLE_TIMEOUT_MS,
			signal,
		});
		await env.start({
			onlyServices: [service],
			startServers: false,
			prepare: "containers",
			skipEnvironmentLog: true,
			// stdout is Prisma's alone.
			verbose: false,
			signal,
		});
		return await use();
	} catch (error) {
		if (error instanceof CommandSignalError)
			return shellExitCode(null, error.signal);
		throw error;
	} finally {
		await env.releaseRun();
		for (const name of signals) process.off(name, cancel);
	}
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
 * The environment as this checkout's live run sees it: the named URLs a run
 * of it serves, entry by entry as `getEnvVar` reads them, and what the run's
 * apps printed.
 */
export async function loadLiveEnv() {
	const { readLiveNamedUrls } = await import("../../core/checkout-view");
	const { adoptLiveCaptures } = await import("../../core/run-publish");
	const env = await loadEnv({ readOnly: true });
	// Answered all the same (`portOffsetProvenance: "unallocated"`): these
	// commands are how an agent finds its way out of a full range.
	if (env.portOffsetProvenance === "unallocated")
		log.warn(unallocatedPortsMessage(env.root));
	const live = env.hosts
		? readLiveNamedUrls(
				env.root,
				env.hosts.plan,
				env.ports as Record<string, number>,
			)
		: undefined;
	if (live) env.setNamedHostsActive(true, live);
	await adoptLiveCaptures(env);
	return env;
}

export async function handleEnv(args: string[] = []): Promise<void> {
	const [action, ...rest] = args;
	if (action === "set" || action === "unset") {
		await (await import("./env-set")).handleEnvSet(action, rest);
		return;
	}
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
					mode: env.hosts.mode,
					tld: env.hosts.tld,
					plan: env.hosts.plan,
					tailscaleUrls: env.hosts.tailscaleUrls,
				}
			: null,
		// What `exec`, tasks and the apps are given (without their secrets),
		// so `DATABASE_URL` can be read rather than reassembled from ports.
		vars: env.buildEnvVars() as Record<string, string>,
		// `buncargo env set` keys, already applied to `vars`.
		overrides: Object.keys(readEnvOverrides(env.root)),
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

	const root = (await import("../../core/ports")).findMonorepoRoot();
	// `typecheck` in dev.config.ts: directories discovery cannot see, and ones
	// to leave out.
	const settings = await (
		await import("../../typecheck/config-settings")
	).loadTypecheckConfig(root);
	if (settings.errors.length > 0) {
		log.fail(settings.errors[0] ?? "Invalid typecheck config.", [
			...settings.errors.slice(1),
		]);
	}
	if (settings.warning) log.warn(settings.warning);
	const groups = settings.config?.groups ?? {};
	const group = parsed.group ? groups[parsed.group] : undefined;
	if (parsed.group && !group) {
		const known = Object.keys(groups);
		log.fail(`Unknown typecheck group: ${parsed.group}`, [
			known.length > 0
				? `Groups in dev.config.ts: ${known.join(", ")}`
				: "Declare one under typecheck.groups in dev.config.ts.",
		]);
	}

	const { runWorkspaceTypecheck } = await import("../../typecheck");
	const { requestedTypecheckConcurrency } =
		await import("../../typecheck/scheduling");
	const { changedFilesSince } = await import("../../typecheck/changed");
	let changedFiles: string[] | undefined;
	if (parsed.changed) {
		try {
			changedFiles = changedFilesSince(root, parsed.changed.ref);
		} catch (error) {
			log.fail(getErrorMessage(error));
		}
	}

	// A machine-wide slot: typechecks from many checkouts at once exhaust memory.
	const { withCheckSlot, formatCheckSlotWait } =
		await import("../../core/check-slots");
	const { runForwardingSignals } = await import("./exec");
	const exitCode = await withCheckSlot(
		"typecheck",
		// Each check runs in its own process group, which the terminal's
		// Ctrl-C does not reach: the signal is forwarded, or every `tsc` would
		// outlive this process.
		() =>
			runForwardingSignals(async (signal) => {
				try {
					const result = await runWorkspaceTypecheck({
						root,
						verbose: true,
						concurrency: requestedTypecheckConcurrency(
							parsed.concurrency,
							settings.config?.concurrency,
						),
						only: parsed.only ?? (group?.only ? [...group.only] : undefined),
						include: settings.config?.include,
						scripts: settings.config?.scripts,
						exclude: [
							...(settings.config?.exclude ?? []),
							...(group?.exclude ?? []),
						],
						includeRootConfig: group?.rootConfig,
						changedFiles,
						signal,
					});
					return { exitCode: result.success ? 0 : 1, stdout: "", stderr: "" };
				} catch (error) {
					// Interrupted: the signal's exit code says so.
					if (signal.aborted) return { exitCode: 1, stdout: "", stderr: "" };
					throw error;
				}
			}),
		{
			onWait: (wait) => log.info(formatCheckSlotWait(wait)),
		},
	);
	process.exit(exitCode);
}
