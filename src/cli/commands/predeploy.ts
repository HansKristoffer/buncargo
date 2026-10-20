import { join } from "node:path";
import { childProcessEnv } from "../../core/child-env";
import { findMonorepoRoot } from "../../core/ports";
import { resolvePrismaConfig } from "../../prisma/config";
import { loadPredeployConfig } from "../../typecheck/config-settings";
import type {
	MigrationConfig,
	PredeployConfig,
	PredeployContext,
	PrismaConfig,
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
				"Migrate, then seed unless production (e.g. Railway's preDeployCommand)",
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

/** The deploy environment's name, from the first variable that is set. */
export function predeployEnvironment(
	config: PredeployConfig,
	env: NodeJS.ProcessEnv = process.env,
): { environment: string; production: boolean } {
	const environment =
		(config.environmentVars ?? DEFAULT_ENVIRONMENT_VARS)
			.map((name) => env[name])
			.find((value) => value !== undefined && value !== "") ?? "dev";
	return {
		environment,
		production: (config.production ?? DEFAULT_PRODUCTION).includes(environment),
	};
}

/**
 * The migrations a dev run applies, here against the deploy's own database:
 * `prisma migrate deploy` in `prisma.cwd`, then `migrations` in order.
 * `requiredServices` is ignored: a deploy has no local services to select.
 */
export function predeployMigrations(root: {
	prisma?: PrismaConfig;
	migrations?: readonly MigrationConfig[];
}): MigrationConfig[] {
	return [
		...(root.prisma
			? [
					{
						name: "prisma",
						command: "bunx --no-install prisma migrate deploy",
						cwd: resolvePrismaConfig(root.prisma).cwd,
					},
				]
			: []),
		...(root.migrations ?? []),
	];
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
 * Migrate, seed outside production, and the config's hooks around both.
 * Throws a `CliError` naming the step that failed.
 */
export async function runPredeploy(
	root: string,
	rootConfig: Record<string, unknown>,
	io: PredeployIo = defaultIo,
): Promise<void> {
	const config = (rootConfig.predeploy ?? {}) as PredeployConfig;
	const seed = rootConfig.seed as
		| { command?: string; cwd?: string }
		| undefined;
	const { environment, production } = predeployEnvironment(config, io.env);
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

	io.log(`environment "${environment}" (production: ${production})`);
	await config.beforeMigrate?.(ctx);

	const retry =
		config.retry === false ? undefined : { ...DEFAULT_RETRY, ...config.retry };
	for (const migration of predeployMigrations(rootConfig)) {
		io.log(`migrating: ${migration.name} (${migration.command})`);
		for (let attempt = 1; ; attempt++) {
			const result = await io.run(
				migration.command,
				join(root, migration.cwd ?? "."),
			);
			if (result.exitCode === 0) break;
			const slotsExhausted =
				retry !== undefined && result.output.includes(retry.match);
			if (!retry || !slotsExhausted || attempt >= retry.attempts) {
				const message = `predeploy: migration ${migration.name} exited ${result.exitCode}.`;
				throw new CliError(message, [
					slotsExhausted
						? "The database stayed out of connection slots: raise predeploy.retry.attempts or lower the running services' pool sizes."
						: "Its output is above; fix the migration and deploy again.",
				]);
			}
			io.log(
				`database refused the connection (attempt ${attempt}/${retry.attempts}), retrying in ${retry.delayMs / 1000}s`,
			);
			await io.sleep(retry.delayMs);
		}
	}
	await config.afterMigrate?.(ctx);

	if (production) io.log("production: not seeding.");
	else if (config.seed === false || !seed?.command) io.log("no seed to run.");
	else {
		io.log(`seeding ${environment} (${seed.command})`);
		await exec(seed.command, seed.cwd);
	}
	await config.afterSeed?.(ctx);
	io.log("done.");
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
	await runPredeploy(root, settings.config);
	return 0;
}
