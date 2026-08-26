import { CONTAINER_RUNTIME_SELECTIONS } from "../container-runtime";
import {
	type CommandSpec,
	enumValidator,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	positiveIntegerValidator,
	readBooleanFlag,
	readStringFlag,
} from "./command-spec";
import { splitCliArgs } from "./flags";
import * as log from "./log";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	down: { name: "--down", kind: "boolean", description: "Stop all containers" },
	all: {
		name: "--all",
		kind: "boolean",
		description: "With --down, stop every buncargo environment on this machine",
	},
	reset: {
		name: "--reset",
		kind: "boolean",
		description: "Stop containers and remove volumes (fresh start)",
	},
	migrate: {
		name: "--migrate",
		kind: "boolean",
		description: "Run migrations and exit",
	},
	seed: {
		name: "--seed",
		kind: "boolean",
		description: "Run migrations and seeders, then exit",
	},
	upOnly: {
		name: "--up-only",
		kind: "boolean",
		description:
			"Start containers and run migrations, then exit (no dev servers)",
	},
	expose: {
		name: "--expose",
		kind: "string",
		valueHint: "[=<targets>]",
		description: "Expose configured targets via public quick tunnels",
	},
	apps: {
		name: "--apps",
		kind: "string",
		valueHint: "=<apps>",
		description: "Run selected apps plus their requiredApps",
	},
	attach: {
		name: "--attach",
		kind: "string",
		valueHint: "=<app>",
		description: "Give one app the TTY (overrides interactive: true)",
	},
	keepContainers: {
		name: "--keep-containers",
		kind: "boolean",
		description: "Do not start the idle watchdog",
	},
	takeover: {
		name: "--takeover",
		kind: "boolean",
		description: "Stop apps already running elsewhere and run them here",
	},
	watchdogTimeout: {
		name: "--watchdog-timeout",
		kind: "string",
		valueHint: "=N",
		description: "Idle backstop in minutes (default: 3)",
		validate: positiveIntegerValidator("--watchdog-timeout"),
	},
	noDockerAutostart: {
		name: "--no-docker-autostart",
		kind: "boolean",
		description: "Do not try to start Docker if it is down",
	},
	noHosts: {
		name: "--no-hosts",
		kind: "boolean",
		description: "Use localhost:port instead of named .localhost URLs",
	},
	runtime: {
		name: "--runtime",
		kind: "string",
		valueHint: "=<docker|apple|auto>",
		description: "Container runtime backend (default: docker)",
		validate: enumValidator("--runtime", CONTAINER_RUNTIME_SELECTIONS),
	},
} as const satisfies Record<string, FlagSpec>;

export const DEV_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo dev [options]",
	flags: Object.values(FLAGS),
	notes: [
		{
			command: "--",
			description: "Extra args appended to the attached app command",
		},
	],
	examples: [
		{
			command: "bun dev",
			description: "Start selected apps and their services",
		},
		{
			command: "bun dev --seed",
			description: "Run migrations and seed the database",
		},
		{ command: "bun dev --down", description: "Stop all containers" },
		{
			command: "bun dev --reset",
			description: "Stop containers and remove all data",
		},
		{
			command: "bun dev --apps=api,platform",
			description: "Run only selected apps",
		},
		{
			command: "bun dev --expose",
			description: "Expose all targets with expose: true",
		},
		{
			command: "bun dev --expose=api,web",
			description: "Expose specific targets",
		},
		{
			command: "bun dev --apps=expoApp -- --clear",
			description: "Pass args to the attached app",
		},
		{
			command: "bun dev --runtime=apple",
			description: "Run services on Apple container instead of Docker",
		},
		{
			command: "bun dev --takeover",
			description: "Move apps running in another terminal into this one",
		},
	],
};

export interface DevCliArgs {
	/** Flags before `--`, kept for error messages. */
	flags: string[];
	/** Args after `--`, appended to the attached app command. */
	passthrough: string[];
	unknownFlags: string[];
	/** Validation failures, reported before the flow starts. */
	errors: string[];
	help: boolean;
	down: boolean;
	all: boolean;
	reset: boolean;
	migrate: boolean;
	seed: boolean;
	upOnly: boolean;
	/** True for both `--expose` and `--expose=a,b`. */
	exposeRequested: boolean;
	exposeValue: string | undefined;
	appsRequested: boolean;
	appsValue: string | undefined;
	attach: string | undefined;
	keepContainers: boolean;
	/** Skip the prompt and stop apps already running elsewhere. */
	takeover: boolean;
	watchdogTimeoutMinutes: number | undefined;
	dockerAutostart: boolean;
	hosts: boolean;
	/** `--runtime`, already validated; undefined falls through to env/config. */
	runtime: string | undefined;
	/** `--migrate`, `--seed` and `--up-only` exit before dev servers start. */
	oneShot: boolean;
}

export function parseDevArgs(rawArgs: string[]): DevCliArgs {
	const { flags, passthrough } = splitCliArgs(rawArgs);
	const errors: string[] = [];
	const bool = (flag: FlagSpec) => readBooleanFlag(flags, flag);
	const str = (flag: FlagSpec) => readStringFlag(flags, flag, errors);

	const migrate = bool(FLAGS.migrate);
	const seed = bool(FLAGS.seed);
	const upOnly = bool(FLAGS.upOnly);
	const watchdogTimeout = str(FLAGS.watchdogTimeout);

	return {
		flags,
		passthrough,
		unknownFlags: findUnknownFlags(DEV_COMMAND_SPEC, flags),
		errors,
		help: bool(FLAGS.help),
		down: bool(FLAGS.down),
		all: bool(FLAGS.all),
		reset: bool(FLAGS.reset),
		migrate,
		seed,
		upOnly,
		exposeRequested: bool(FLAGS.expose),
		exposeValue: str(FLAGS.expose),
		appsRequested: bool(FLAGS.apps),
		appsValue: str(FLAGS.apps),
		attach: str(FLAGS.attach),
		keepContainers: bool(FLAGS.keepContainers),
		takeover: bool(FLAGS.takeover),
		watchdogTimeoutMinutes:
			watchdogTimeout === undefined
				? undefined
				: Number.parseInt(watchdogTimeout, 10),
		dockerAutostart: !bool(FLAGS.noDockerAutostart),
		hosts: !bool(FLAGS.noHosts),
		runtime: str(FLAGS.runtime),
		oneShot: migrate || seed || upOnly,
	};
}

export function printDevHelp(): void {
	console.log(formatCommandHelp(DEV_COMMAND_SPEC));
}

/**
 * Report an argv problem and exit, or return.
 *
 * Both entry points call this: `handleDev` before it loads a config, so a typo
 * is not answered with a config error, and `runCli`, which programmatic callers
 * reach directly with their own argv. Whichever runs first exits, so the two
 * cannot report the same problem differently.
 */
export function exitOnDevArgErrors(args: DevCliArgs): void {
	const messages =
		args.unknownFlags.length > 0
			? [
					`Unknown flag${args.unknownFlags.length > 1 ? "s" : ""}: ${args.unknownFlags.join(", ")}`,
				]
			: args.errors;
	if (messages.length === 0) return;

	for (const message of messages) {
		log.error(message);
	}
	if (args.unknownFlags.length > 0) {
		log.line();
		printDevHelp();
	}
	process.exit(1);
}
