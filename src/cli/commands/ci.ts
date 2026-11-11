import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { typedSwitch, typedSwitchGroup } from "hanzio";
import { CONTAINER_RUNTIME_SELECTIONS } from "../../container-runtime";
import { formatCheckSlotWait, withCheckSlot } from "../../core/check-slots";
import { CI_PROJECT_SUFFIX } from "../../core/ports";
import { WATCHDOG_IDLE_TIMEOUT_MS } from "../../core/watchdog-constants";
import { loadDevEnv } from "../../loader";
import type { AnyDevEnvironment, ExecResult, SeedOutcome } from "../../types";
import {
	BASE_EXITS,
	commaList,
	defineCommand,
	enumValidator,
} from "../command-spec";
import { CliError } from "../errors";
import * as log from "../log";
import { runForwardingSignals } from "./exec";

const SCHEMA_MODES = ["migrate", "push"] as const;

interface CiRequest {
	migrate: boolean;
	seed: boolean;
	schemaPush: boolean;
	slot: boolean;
	services: string[] | undefined;
	runtime: string | undefined;
	command: readonly string[];
}

/**
 * Say who removed the stack when a step failed because it was gone.
 *
 * Before the teardown, which would otherwise be the only sign: Compose's "No
 * resource found to remove", long after the command failed on a refused
 * connection.
 */
async function reportContainerLoss(
	env: Pick<AnyDevEnvironment, "explainMissingContainers">,
): Promise<void> {
	const loss = await env.explainMissingContainers();
	if (loss) log.warn(loss);
}

/**
 * The suffix one `buncargo ci` runs its stack under: `ci-<id>`, so two runs in
 * one checkout never share a project, plus a self-hosted runner's name, so
 * `docker ps` on a shared machine says whose stack it is.
 */
function ciSuffix(): string {
	const { RUNNER_ENVIRONMENT, RUNNER_NAME } = process.env;
	const runner =
		RUNNER_ENVIRONMENT === "self-hosted"
			? RUNNER_NAME?.toLowerCase().replace(/[^a-z0-9]+/g, "-")
			: undefined;
	const id = randomBytes(3).toString("hex");
	return [CI_PROJECT_SUFFIX, id, runner].filter(Boolean).join("-");
}

/**
 * Local services in CI: start them, apply migrations and the seed with the
 * same config as local, run the command with the environment, tear down.
 *
 * Each run is its own stack, with its data on tmpfs: a CI run that leaves a
 * database behind leaks it into the next job on a reused runner, and one run
 * finishing must never take down another's. Returns the command's exit code,
 * or 0 when only services/migrations/seed were asked for.
 */
export const ciCommand = defineCommand({
	spec: {
		name: "ci",
		summary: "Start services in CI, prepare them, run a command, tear down",
		flags: {
			migrate: {
				kind: "boolean",
				description:
					"Run migrations (and Prisma generate) after services start",
			},
			seed: {
				kind: "boolean",
				description: "Run migrations, then the seed command",
			},
			schema: {
				kind: "string",
				value: "<migrate|push>",
				description:
					"How the Prisma schema is applied: its migrations, or `prisma db push` (implies --migrate)",
				validate: enumValidator("--schema", SCHEMA_MODES),
			},
			slot: {
				kind: "boolean",
				description:
					"Hold one of the machine's check slots from before the services start until teardown",
			},
			services: {
				kind: "string",
				value: "<names>",
				description:
					"Start only these services (default: every configured one)",
			},
			runtime: {
				kind: "string",
				value: "<docker|apple|auto>",
				description: "Container runtime backend (default: docker)",
				validate: enumValidator("--runtime", CONTAINER_RUNTIME_SELECTIONS),
			},
		},
		passthrough: "Command to run with the checkout environment",
		examples: [
			{
				command: "buncargo ci --migrate -- bun test",
				description: "Services up, migrations applied, tests, teardown",
			},
			{
				command: "buncargo ci --seed",
				description: "Check that migrations and the seed apply cleanly",
			},
			{
				command: "buncargo ci --schema=push --slot -- bun test",
				description:
					"A unit shard: the schema pushed, not migrated, inside a check slot",
			},
		],
	},
	exits: {
		...BASE_EXITS,
		1: "preparation failed, or bad arguments; otherwise the command's own code",
	},
	run: ({ values, passthrough }) =>
		withStatusOnStderr(() =>
			runCi({
				migrate: values.migrate,
				seed: values.seed,
				schemaPush: values.schema === "push",
				slot: values.slot,
				services:
					values.services === undefined
						? undefined
						: commaList(values.services),
				runtime: values.runtime,
				command: passthrough,
			}),
		),
});

/**
 * Run `work` with `console.log` writing to stderr. A wrapper's stdout is the
 * wrapped command's alone, and the environment it starts and stops reports
 * its progress with `console.log`. The command itself writes to the
 * inherited file descriptor, past this.
 */
async function withStatusOnStderr<T>(work: () => Promise<T>): Promise<T> {
	const { log, info } = console;
	console.log = console.info = (...data: unknown[]) => console.error(...data);
	try {
		return await work();
	} finally {
		console.log = log;
		console.info = info;
	}
}

async function runCi(parsed: CiRequest): Promise<number> {
	// A stack of its own, under a name no other run has, with its data in
	// memory: tearing it down never reaches the checkout's dev database or
	// another `ci` run's services, and a run killed outright leaves no volume.
	const checkout = await loadDevEnv({ containerRuntime: parsed.runtime });
	const env = checkout.withSuffix(ciSuffix(), { data: "tmpfs" });
	const prisma = env.prisma;
	if (parsed.schemaPush && !prisma) {
		throw new CliError(
			"--schema=push needs a prisma block in your dev config.",
		);
	}
	const services = parsed.services ?? Object.keys(env.services);
	const unknown = services.filter((name) => !env.services[name]);
	if (unknown.length > 0) {
		throw new CliError(`Unknown service(s): ${unknown.join(", ")}`, [
			`Configured services: ${Object.keys(env.services).join(", ") || "none"}`,
		]);
	}
	if (prisma && parsed.schemaPush && !services.includes(prisma.service)) {
		throw new CliError(
			`--schema=push needs the ${prisma.service} service, which --services leaves out.`,
		);
	}
	// Unless `docker.generatedFile` names one file for every stack.
	const ownComposeFile =
		env.composeFile !== checkout.composeFile
			? resolve(env.root, env.composeFile)
			: undefined;

	// The teardown runs inside the signal scope: a second Ctrl-C, or the
	// runner's SIGTERM after its SIGINT, arriving while the stack comes down
	// would otherwise kill this process half way and leave the stack. The
	// containers' own commands run in their own process group, so the
	// terminal's signal does not reach them.
	const run = () =>
		runForwardingSignals(async (signal) => {
			try {
				return await env.withServices(
					services,
					{
						// A hold, unlike a library run's keep-forever default: a run
						// killed outright (`SIGKILL`) cannot tear down, and with no
						// hold the sweep keeps its stack for as long as the checkout
						// exists. Explicit, so a config's `autoShutdown: false`, which
						// is about dev containers, does not keep a ci stack.
						claim: { idleTimeoutMs: WATCHDOG_IDLE_TIMEOUT_MS },
						prepare:
							parsed.migrate || parsed.seed || parsed.schemaPush
								? "all"
								: "containers",
						schema: parsed.schemaPush ? "push" : "migrate",
						// Forced: `seed.check` is for skipping a seed on a warm local
						// database, and a CI database is never warm.
						seed: parsed.seed ? "force" : "skip",
						// This process tears the containers down itself, and a CI
						// runner is thrown away after the job anyway.
						watchdog: false,
						after: { stop: { removeVolumes: true } },
						signal,
					},
					async ({ seed }) => {
						const failedSeed = seed && seedFailure(seed);
						if (failedSeed) {
							await reportContainerLoss(env);
							return exited(failedSeed.exitCode || 1);
						}

						if (parsed.command.length === 0) return exited(0);

						// The command gets no shared scope: a CI job should not need
						// Infisical access for its tests. Migrations and the seed
						// still get their own scopes.
						const result = await env.exec(parsed.command, {
							secrets: false,
							verbose: true,
							throwOnError: false,
							signal,
						});
						if (result.exitCode !== 0 && !signal.aborted)
							await reportContainerLoss(env);
						return result;
					},
				);
			} catch (error) {
				// Interrupted before the command: the signal's exit code says so.
				if (signal.aborted) return exited(1);
				throw error;
			} finally {
				if (ownComposeFile) rmSync(ownComposeFile, { force: true });
			}
		});

	if (!parsed.slot) return run();
	return withCheckSlot(["ci", ...parsed.command].join(" ").slice(0, 60), run, {
		onWait: (wait) => console.error(formatCheckSlotWait(wait)),
	});
}

function exited(exitCode: number): ExecResult {
	return { exitCode, stdout: "", stderr: "" };
}

/** The seed's failed run, or undefined when it succeeded or had nothing to do. */
function seedFailure(outcome: SeedOutcome): ExecResult | undefined {
	return typedSwitch(outcome, "status", {
		"not-configured": () => {
			throw new CliError("--seed needs a seed block in your dev config.");
		},
		...typedSwitchGroup(
			outcome,
			"status",
			["not-needed", "succeeded"],
			() => undefined,
		),
		failed: (failed) => failed.result,
	});
}
