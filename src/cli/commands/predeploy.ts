import { join } from "node:path";
import { getErrorMessage } from "hanzio";
import { validateSupplementShapes } from "../../config/validation/config-shapes";
import { createShapeChecks } from "../../config/validation/shape-checks";
import { childProcessEnv } from "../../core/child-env";
import { findMonorepoRoot } from "../../core/ports";
import { migrationsFor } from "../../prisma/migrations-for";
import { loadPredeployConfig } from "../../typecheck/config-settings";
import type {
	AnyDevConfig,
	MigrationConfig,
	PredeployConfig,
	PredeployContext,
	PredeployFailure,
} from "../../types";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
} from "../command-spec";
import { argumentsError, CliError } from "../errors";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
} as const;

export const PREDEPLOY_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo predeploy",
	flags: Object.values(FLAGS),
	examples: [
		{
			command: "bunx buncargo predeploy",
			description:
				"Migrate, then seed a named environment outside production (e.g. Railway's preDeployCommand)",
		},
	],
};

const DEFAULT_ENVIRONMENT_VARS = ["SECRETS_ENV", "NODE_ENV"];
const DEFAULT_PRODUCTION = ["prod", "production"];
// Postgres SQLSTATE 53300. A small instance (PlanetScale's allow 25
// connections) refuses `migrate deploy` while the previous deploy's pods and
// the sibling service's pre-deploy hold every slot; PgBouncer recycles idle
// server links within minutes, so waiting is what frees one.
const DEFAULT_RETRY = {
	match: "remaining connection slots are reserved",
	attempts: 20,
	delayMs: 15_000,
};

export interface PredeployEnvironment {
	/** The deploy environment's name; `dev` when no variable names one. */
	environment: string;
	production: boolean;
	/** Whether one of the `environmentVars` named it. */
	named: boolean;
}

/** The deploy environment's name, from the first variable that is set. */
export function predeployEnvironment(
	config: PredeployConfig,
	env: NodeJS.ProcessEnv,
): PredeployEnvironment {
	const named = (config.environmentVars ?? DEFAULT_ENVIRONMENT_VARS)
		.map((name) => env[name])
		.find((value) => value !== undefined && value !== "");
	const environment = named ?? "dev";
	return {
		environment,
		production: (config.production ?? DEFAULT_PRODUCTION).includes(environment),
		named: named !== undefined,
	};
}

/**
 * Whether and with what predeploy seeds. Never production, never an
 * environment no variable named, only `seedIn` when it is set. The command is
 * `predeploy.seed` from the root, else the dev run's `seed.command`; `false`
 * never seeds.
 */
function planPredeploySeed(
	config: PredeployConfig,
	devSeed: { command?: string; cwd?: string } | undefined,
	deploy: PredeployEnvironment,
):
	| { kind: "seed"; command: string; cwd?: string }
	| { kind: "skip"; reason: string } {
	const { environment } = deploy;
	if (deploy.production)
		return { kind: "skip", reason: "production: not seeding." };
	if (!deploy.named) {
		const variables = (config.environmentVars ?? DEFAULT_ENVIRONMENT_VARS).join(
			" or ",
		);
		return {
			kind: "skip",
			reason: `no ${variables} names the environment: not seeding. Set one to seed it.`,
		};
	}
	const excluded =
		config.seedIn !== undefined && !config.seedIn.includes(environment);
	if (excluded)
		return {
			kind: "skip",
			reason: `"${environment}" is not in predeploy.seedIn: not seeding.`,
		};
	const nothing = { kind: "skip", reason: "no seed to run." } as const;
	if (config.seed === false) return nothing;
	if (config.seed !== undefined) return { kind: "seed", command: config.seed };
	if (!devSeed?.command) return nothing;
	return { kind: "seed", command: devSeed.command, cwd: devSeed.cwd };
}

/**
 * The migration Prisma recorded as failed, when `output` is Prisma's P3009
 * (a failed migration blocks new ones) or P3018 (a migration failed to apply).
 */
function failedPrismaMigration(output: string): string | undefined {
	if (!/\bP30(09|18)\b/.test(output)) return undefined;
	const named =
		/The `([^`]+)` migration started at/.exec(output) ??
		/Migration name: (\S+)/.exec(output);
	return named?.[1];
}

/** What predeploy reads from the root config, checked as it loads. */
export interface PredeployInputs {
	predeploy?: PredeployConfig;
	prisma?: AnyDevConfig["prisma"];
	migrations?: AnyDevConfig["migrations"];
	seed?: { command?: string; cwd?: string };
}

/**
 * The root config's keys predeploy reads, validated as `validateConfig`
 * validates them.
 */
function readPredeployInputs(
	rootConfig: Record<string, unknown>,
): PredeployInputs {
	const { predeploy, prisma, migrations, seed } = rootConfig;
	const errors: string[] = [];
	validateSupplementShapes(
		{ prisma, migrations, seed },
		createShapeChecks(errors),
	);
	if (errors.length > 0)
		throw new CliError(errors[0] ?? "Invalid dev config.", errors.slice(1));
	// Validated above; `predeploy` by the loader.
	return { predeploy, prisma, migrations, seed } as PredeployInputs;
}

export interface PredeployIo {
	/** Runs a shell command; resolves to its exit code and combined output. */
	run: (
		command: string,
		cwd: string,
	) => Promise<{ exitCode: number; output: string }>;
	sleep: (ms: number) => Promise<void>;
	log: (message: string) => void;
	env: NodeJS.ProcessEnv;
}

/** Streams the command's output and keeps a copy to match the retry against. */
async function runShell(command: string, cwd: string) {
	const child = Bun.spawn(["sh", "-c", command], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: childProcessEnv(),
	});
	const tee = async (
		stream: ReadableStream<Uint8Array>,
		sink: NodeJS.WriteStream,
	) => {
		let text = "";
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return text;
			sink.write(value);
			text += decoder.decode(value, { stream: true });
		}
	};
	const [stdout, stderr, exitCode] = await Promise.all([
		tee(child.stdout, process.stdout),
		tee(child.stderr, process.stderr),
		child.exited,
	]);
	return { exitCode, output: stdout + stderr };
}

const defaultIo: PredeployIo = {
	run: runShell,
	sleep: (ms) => Bun.sleep(ms),
	log: (message) => console.log(`predeploy: ${message}`),
	env: process.env,
};

/**
 * Migrate, seed when {@link planPredeploySeed} says so, and the config's hooks
 * around both. Throws a `CliError` naming the step that failed, after
 * `onFailure`.
 */
export async function runPredeploy(
	root: string,
	inputs: PredeployInputs,
	io: PredeployIo = defaultIo,
): Promise<void> {
	const config = inputs.predeploy ?? {};
	const deploy = predeployEnvironment(config, io.env);
	const { environment, production } = deploy;
	const seed = planPredeploySeed(config, inputs.seed, deploy);
	const exec = async (command: string, cwd = ".") => {
		const result = await io.run(command, join(root, cwd));
		if (result.exitCode === 0) return;
		const message = `predeploy: \`${command}\` exited ${result.exitCode}.`;
		throw new CliError(message, ["Its output is above."]);
	};
	const ctx: PredeployContext = {
		root,
		environment,
		production,
		exec: (command, options) => exec(command, options?.cwd),
	};
	let step: Omit<PredeployFailure, "message"> = { step: "beforeMigrate" };

	try {
		io.log(`environment "${environment}" (production: ${production})`);
		await config.beforeMigrate?.(ctx);

		for (const migration of migrationsFor(inputs)) {
			step = { step: "migrate", migration: migration.name };
			const failed = await migrate(migration, root, config, io);
			if (failed) {
				step = { ...step, failedPrismaMigration: failed.failedPrismaMigration };
				throw failed.error;
			}
		}
		step = { step: "afterMigrate" };
		await config.afterMigrate?.(ctx);

		step = { step: "seed" };
		if (seed.kind === "skip") io.log(seed.reason);
		else {
			io.log(`seeding ${environment} (${seed.command})`);
			await exec(seed.command, seed.cwd);
		}
		step = { step: "afterSeed" };
		await config.afterSeed?.(ctx);
		io.log("done.");
	} catch (error) {
		await reportFailure(
			config,
			ctx,
			{ ...step, message: getErrorMessage(error) },
			io,
		);
		throw error;
	}
}

/** `onFailure`, whose own failure is printed and leaves the deploy's error to throw. */
async function reportFailure(
	config: PredeployConfig,
	ctx: PredeployContext,
	failure: PredeployFailure,
	io: PredeployIo,
): Promise<void> {
	try {
		await config.onFailure?.(ctx, failure);
	} catch (error) {
		io.log(`predeploy.onFailure threw: ${getErrorMessage(error)}`);
	}
}

/**
 * One migration, retried while the database has no free connection slots.
 * Resolves to the failure, if it failed.
 */
async function migrate(
	migration: MigrationConfig,
	root: string,
	config: PredeployConfig,
	io: PredeployIo,
): Promise<{ error: CliError; failedPrismaMigration?: string } | undefined> {
	const retry =
		config.retry === false ? undefined : { ...DEFAULT_RETRY, ...config.retry };
	io.log(`migrating: ${migration.name} (${migration.command})`);
	for (let attempt = 1; ; attempt++) {
		const result = await io.run(
			migration.command,
			join(root, migration.cwd ?? "."),
		);
		if (result.exitCode === 0) return undefined;
		const slotsExhausted =
			retry !== undefined && result.output.includes(retry.match);
		if (!retry || !slotsExhausted || attempt >= retry.attempts) {
			const message = `predeploy: migration ${migration.name} exited ${result.exitCode}.`;
			const failedPrisma = failedPrismaMigration(result.output);
			const hints = slotsExhausted
				? [
						"The database stayed out of connection slots: raise predeploy.retry.attempts or lower the running services' pool sizes.",
					]
				: failedPrisma
					? resolveHints(failedPrisma, migration.cwd)
					: ["Its output is above; fix the migration and deploy again."];
			return {
				error: new CliError(message, hints),
				failedPrismaMigration: failedPrisma,
			};
		}
		io.log(
			`database refused the connection (attempt ${attempt}/${retry.attempts}), retrying in ${retry.delayMs / 1000}s`,
		);
		await io.sleep(retry.delayMs);
	}
}

/** How to unblock deploys after Prisma recorded `name` as failed. */
function resolveHints(name: string, cwd = "."): string[] {
	return [
		`Prisma recorded migration ${name} as failed, and every later deploy stops here until it is resolved.`,
		`Undo what it applied, then, against the deploy's database from ${cwd}: bunx prisma migrate resolve --rolled-back ${name}`,
		`If you finished it by hand instead: bunx prisma migrate resolve --applied ${name}`,
	];
}

/**
 * `buncargo predeploy`: the one-off step before a deploy. Reads the config
 * module only and runs with the deploy's own environment: no ports, no
 * containers, no secrets of buncargo's.
 */
export async function handlePredeploy(args: string[]): Promise<number> {
	if (readBooleanFlag(args, FLAGS.help)) {
		console.log(formatCommandHelp(PREDEPLOY_COMMAND_SPEC));
		return 0;
	}
	const errors = [
		...findUnknownFlags(PREDEPLOY_COMMAND_SPEC, args).map(
			(flag) => `Unknown flag: ${flag}`,
		),
		...readPositionals(PREDEPLOY_COMMAND_SPEC, args).map(
			(token) => `Unexpected argument: ${token}`,
		),
	];
	if (errors.length > 0) throw argumentsError(errors, "predeploy");

	const root = findMonorepoRoot();
	const settings = await loadPredeployConfig(root);
	if (settings.errors.length > 0)
		throw new CliError(settings.errors[0] ?? "Invalid predeploy config.", [
			...settings.errors.slice(1),
		]);
	// Unlike `typecheck`, a deploy must not migrate with half a config.
	if (settings.warning || !settings.config)
		throw new CliError(settings.warning ?? "No dev.config.ts found.");
	await runPredeploy(root, readPredeployInputs(settings.config));
	return 0;
}
