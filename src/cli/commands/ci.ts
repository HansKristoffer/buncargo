import { CONTAINER_RUNTIME_SELECTIONS } from "../../container-runtime";
import { loadDevEnv } from "../../loader";
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
	).withSuffix("ci");
	const services = parsed.services ?? Object.keys(env.services);
	const unknown = services.filter((name) => !env.services[name]);
	if (unknown.length > 0) {
		throw new CliError(`Unknown service(s): ${unknown.join(", ")}`, [
			`Configured services: ${Object.keys(env.services).join(", ") || "none"}`,
		]);
	}

	try {
		return await runForwardingSignals(async (signal) => {
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
				if (outcome.status === "failed")
					return {
						exitCode: outcome.result.exitCode || 1,
						stdout: "",
						stderr: "",
					};
			}

			if (parsed.command.length === 0) {
				return { exitCode: 0, stdout: "", stderr: "" };
			}

			return env.exec(parsed.command, {
				verbose: true,
				throwOnError: false,
				signal,
			});
		});
	} finally {
		await env.stop({ removeVolumes: true });
	}
}
