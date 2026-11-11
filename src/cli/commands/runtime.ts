import { getErrorMessage } from "hanzio";
import { readEnvOverrides } from "../../core/env-overrides";
import { unallocatedPortsMessage } from "../../core/port-exhaustion";
import { CommandSignalError, shellExitCode } from "../../core/process/exec";
import { isInteractive } from "../../core/prompt";
import { hostsMode, isCI } from "../../core/runtime-flags";
import { createNoopPhaseTimer, createPhaseTimer } from "../../core/timing";
import { WATCHDOG_IDLE_TIMEOUT_MS } from "../../core/watchdog-constants";
import type { AnyDevEnvironment } from "../../types";
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
	// `--yes` is buncargo's, not Prisma's.
	const yes = rawArgs.includes("--yes");
	const args = rawArgs.filter((arg) => arg !== "--yes");
	// Parsed before the config loads, so a typo is not answered with a config error.
	const migrateCheck =
		args[0] === "migrate-check"
			? parseMigrateCheckArgs(args.slice(1))
			: undefined;
	const { destructivePrismaAction } = await import("../../prisma");
	refuseDestructivePrisma(destructivePrismaAction(args), args, {
		yes,
		interactive: isInteractive(),
		ci: isCI(),
	});
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
	const { prisma } = env;
	if (args.length === 0) process.exit(await prisma.run(args));

	const exitCode = await withClaimedDatabase(env, prisma.service, () =>
		migrateCheck ? prisma.migrateCheck(migrateCheck) : prisma.run(args),
	);
	process.exit(exitCode);
}

/**
 * Refuse a destructive Prisma action without a terminal unless `--yes`, as
 * `dev --reset` does: an agent "fixing" a migration with `migrate reset` wipes
 * the developer's database. CI is exempt; its databases are disposable.
 */
function refuseDestructivePrisma(
	action: string | undefined,
	args: readonly string[],
	context: { yes: boolean; interactive: boolean; ci: boolean },
): void {
	const asked = context.yes || context.interactive || context.ci;
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
 * The environment as this checkout's live run sees it: the named URLs the
 * daemon is actually serving, and what the run's apps printed.
 */
export async function loadLiveEnv() {
	const { getCaPath, waitForDaemonRoutes } = await import("../../core/hosts");
	const { readLiveNamedHostsSync } =
		await import("../../core/hosts/route-owners");
	const { readServedTailscaleUrls } =
		await import("../../core/hosts/tailscale-serve");
	const { adoptLiveCaptures } = await import("../../core/run-publish");
	const env = await loadEnv({ readOnly: true });
	// Answered all the same (`portOffsetProvenance: "unallocated"`): these
	// commands are how an agent finds its way out of a full range.
	if (env.portOffsetProvenance === "unallocated")
		log.warn(unallocatedPortsMessage(env.root));
	const mode = hostsMode();
	// What the run recorded Tailscale answering for, never a request of our own.
	if (env.hosts && mode === "tailscale") {
		const tailscaleUrls = await readServedTailscaleUrls(
			env.root,
			env.ports as Record<string, number>,
		);
		if (Object.keys(tailscaleUrls).length > 0)
			env.setNamedHostsActive(true, { tailscaleUrls });
	}
	// Named while a run of this checkout serves them: registered by a live
	// run, as `getEnvVar` reads it, and the daemon answering for them, which
	// only an async reader can also confirm. A healthy daemon alone is not a
	// daemon serving this project. Zero wait — this only reports state, so an
	// unpicked-up route reads as localhost rather than blocking the command.
	if (env.hosts && mode === "loopback") {
		const hostnames = readLiveNamedHostsSync(env.root, env.hosts.plan).map(
			(entry) => entry.hostname,
		);
		const serving =
			hostnames.length > 0 &&
			(await waitForDaemonRoutes(hostnames, { timeoutMs: 0 })).ok;
		if (serving) {
			env.setNamedHostsActive(true, { caPath: getCaPath(), hostnames });
		}
	}
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
