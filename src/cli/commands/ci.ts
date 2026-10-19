import {
	CONTAINER_RUNTIME_SELECTIONS,
	containerRuntimeForEnv,
	withProjectLifecycleLock,
} from "../../container-runtime";
import { CI_PROJECT_SUFFIX } from "../../core/ports";
import { type RunEntry, readAllRuns } from "../../core/run-registry";
import { WATCHDOG_IDLE_TIMEOUT_MS } from "../../core/watchdog-constants";
import { loadDevEnv } from "../../loader";
import type {
	AnyDevEnvironment,
	BuncargoContainer,
	BuncargoVolume,
} from "../../types";
import {
	type CommandSpec,
	enumValidator,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
	readStringFlag,
} from "../command-spec";
import { argumentsError, CliError } from "../errors";
import { splitCliArgs } from "../flags";
import * as log from "../log";
import { runForwardingSignals } from "./exec";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	migrate: {
		name: "--migrate",
		kind: "boolean",
		description: "Run migrations (and Prisma generate) after services start",
	},
	seed: {
		name: "--seed",
		kind: "boolean",
		description: "Run migrations, then the seed command",
	},
	services: {
		name: "--services",
		kind: "string",
		valueHint: "=<names>",
		description: "Start only these services (default: every configured one)",
		validate: (value: string) =>
			value ? undefined : "--services requires service names",
	},
	runtime: {
		name: "--runtime",
		kind: "string",
		valueHint: "=<docker|apple|auto>",
		description: "Container runtime backend (default: docker)",
		validate: enumValidator("--runtime", CONTAINER_RUNTIME_SELECTIONS),
	},
} as const satisfies Record<string, FlagSpec>;

export const CI_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo ci [options] [-- <command> [args...]]",
	flags: Object.values(FLAGS),
	notes: [
		{
			command: "--",
			description: "Command to run with the checkout environment",
		},
	],
	examples: [
		{
			command: "buncargo ci --migrate -- bun test",
			description: "Services up, migrations applied, tests, teardown",
		},
		{
			command: "buncargo ci --seed",
			description: "Check that migrations and the seed apply cleanly",
		},
	],
};

export function parseCiArgs(args: string[]) {
	const { flags, passthrough } = splitCliArgs(args);
	const errors: string[] = [];
	const services = readStringFlag(flags, FLAGS.services, errors);
	for (const flag of findUnknownFlags(CI_COMMAND_SPEC, flags))
		errors.push(`Unknown flag: ${flag}`);
	for (const arg of readPositionals(CI_COMMAND_SPEC, flags))
		errors.push(`Unexpected argument before --: ${arg}`);

	return {
		help: readBooleanFlag(flags, FLAGS.help),
		migrate: readBooleanFlag(flags, FLAGS.migrate),
		seed: readBooleanFlag(flags, FLAGS.seed),
		services: services
			?.split(",")
			.map((name) => name.trim())
			.filter(Boolean),
		runtime: readStringFlag(flags, FLAGS.runtime, errors),
		command: passthrough,
		errors,
	};
}

/**
 * Say who removed the stack when a step failed because it was gone.
 *
 * Before the teardown, which would otherwise be the only sign: Compose's "No
 * resource found to remove", long after the command failed on a refused
 * connection.
 */
function reportContainerLoss(
	env: Pick<AnyDevEnvironment, "explainMissingContainers">,
): void {
	const loss = env.explainMissingContainers();
	if (loss) log.warn(loss);
}

/**
 * The volumes a killed `buncargo ci` run left in its `-ci` project.
 *
 * A run killed outright cannot tear down, so its volumes outlive its containers.
 * They are this run's own: no container of the project is up and no run on
 * record names it. Anything else belongs to a run that is still going, and is
 * left alone.
 */
export function ciLeftoverVolumes(input: {
	projectName: string;
	volumes: readonly BuncargoVolume[];
	containers: readonly BuncargoContainer[];
	runs: readonly RunEntry[];
}): string[] {
	const { projectName } = input;
	if (input.containers.some((container) => container.project === projectName))
		return [];
	if (input.runs.some((run) => run.projectName === projectName)) return [];
	return input.volumes
		.filter((volume) => volume.project === projectName)
		.map((volume) => volume.name);
}

/**
 * Remove a killed run's leftover volumes before this run starts, so its
 * database starts empty, as every CI run's does.
 *
 * Only what `buncargo ci` would have removed on its own teardown, and only in
 * its own project. A busy project lock or a runtime that cannot answer means
 * someone else is working there, so the run goes ahead without the cleanup.
 */
async function removeCiLeftovers(env: AnyDevEnvironment): Promise<void> {
	const runtime = containerRuntimeForEnv(env);
	try {
		await withProjectLifecycleLock(
			env.projectName,
			env.root,
			async () => {
				const names = ciLeftoverVolumes({
					projectName: env.projectName,
					volumes: await runtime.listVolumes(),
					containers: runtime.list(),
					runs: await readAllRuns(),
				});
				if (names.length === 0) return;
				const refused = await runtime.removeVolumes(names);
				for (const { name, error } of refused)
					log.warn(`Could not remove leftover volume ${name}: ${error}`);
				const removed = names.length - refused.length;
				if (removed > 0)
					log.info(
						`Removed ${removed} leftover volume${removed === 1 ? "" : "s"} of ${env.projectName}, from a run that did not finish`,
					);
			},
			{ timeoutMs: 0 },
		);
	} catch {
		// A busy lock, or a runtime that is not up: the run itself reports it
		// with a clearer message than a cleanup could.
	}
}

/**
 * Local services in CI: start them, apply migrations and the seed with the
 * same config as local, run the command with the environment, tear down.
 *
 * The teardown removes volumes, because a CI run that leaves a database behind
 * leaks it into the next job on a reused runner. Returns the command's exit
 * code, or 0 when only services/migrations/seed were asked for.
 */
export async function handleCi(args: string[]): Promise<number> {
	const parsed = parseCiArgs(args);
	if (parsed.help) {
		console.log(formatCommandHelp(CI_COMMAND_SPEC));
		return 0;
	}
	if (parsed.errors.length > 0) {
		throw argumentsError(parsed.errors, "ci");
	}

	// Its own `<project>-ci` stack: tearing down with volumes must never reach
	// the checkout's dev database, which is exactly what it would do if a
	// developer ran this locally against the shared project.
	const env = (
		await loadDevEnv({ containerRuntime: parsed.runtime })
	).withSuffix(CI_PROJECT_SUFFIX);
	const services = parsed.services ?? Object.keys(env.services);
	const unknown = services.filter((name) => !env.services[name]);
	if (unknown.length > 0) {
		throw new CliError(`Unknown service(s): ${unknown.join(", ")}`, [
			`Configured services: ${Object.keys(env.services).join(", ") || "none"}`,
		]);
	}

	// The teardown runs inside the signal scope: a second Ctrl-C, or the
	// runner's SIGTERM after its SIGINT, arriving while the stack comes down
	// would otherwise kill this process half way and leave the stack, volume
	// included. The containers' own commands run in their own process group,
	// so the terminal's signal does not reach them.
	return runForwardingSignals(async (signal) => {
		try {
			// Claimed with a hold, unlike a library run's keep-forever default:
			// a run killed outright (`SIGKILL`) cannot tear down, and with no
			// hold the sweep keeps its stack for as long as the checkout exists.
			// Explicit, so a config's `autoShutdown: false`, which is about dev
			// containers, does not keep a ci stack. Prepared first: the claim
			// names the selection's services.
			await removeCiLeftovers(env);
			await env.prepareStartAsync(undefined, services, signal);
			await env.claimRun({ idleTimeoutMs: WATCHDOG_IDLE_TIMEOUT_MS, signal });
			await env.start({
				onlyServices: services,
				startServers: false,
				prepare: parsed.migrate || parsed.seed ? "all" : "containers",
				// Explicit, below: `seed.check` is for skipping a seed on a warm
				// local database, and a CI database is never warm.
				skipSeed: true,
				// This process tears the containers down itself, and a CI runner
				// is thrown away after the job anyway.
				watchdog: false,
				signal,
			});

			if (parsed.seed) {
				const outcome = await env.runSeed({ force: true, signal });
				if (outcome.status === "not-configured")
					throw new CliError("--seed needs a seed block in your dev config.");
				if (outcome.status === "failed") {
					reportContainerLoss(env);
					return {
						exitCode: outcome.result.exitCode || 1,
						stdout: "",
						stderr: "",
					};
				}
			}

			if (parsed.command.length === 0) {
				return { exitCode: 0, stdout: "", stderr: "" };
			}

			// The command gets no shared scope: a CI job should not need
			// Infisical access for its tests. Migrations and the seed still get
			// their own scopes.
			const result = await env.exec(parsed.command, {
				secrets: false,
				verbose: true,
				throwOnError: false,
				signal,
			});
			if (result.exitCode !== 0 && !signal.aborted) reportContainerLoss(env);
			return result;
		} catch (error) {
			// Interrupted before the command: the signal's exit code says so.
			if (signal.aborted) return { exitCode: 1, stdout: "", stderr: "" };
			reportContainerLoss(env);
			throw error;
		} finally {
			await env.stop({ removeVolumes: true });
		}
	});
}
