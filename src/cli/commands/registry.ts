import type { AnyCommand } from "../command-spec";

/**
 * The top-level commands, in the order the root help lists them. Each module
 * loads only when its command runs: `bin.ts` dispatches one, and only the
 * root help and `help agents exits` load them all.
 */
const COMMANDS = {
	setup: async () => (await import("./setup")).setupCommand,
	run: async () => (await import("./run")).runTaskCommand,
	wait: async () => (await import("./wait")).waitCommand,
	generate: async () => (await import("./generate")).generateCommand,
	build: async () => (await import("./build")).buildCommand,
	exec: async () => (await import("./exec")).execCommand,
	slot: async () => (await import("./slot")).slotCommand,
	connect: async () => (await import("./connect")).connectCommand,
	dev: async () => (await import("./dev")).devCommand,
	typecheck: async () => (await import("./typecheck")).typecheckCommand,
	check: async () => (await import("./check/index")).checkCommand,
	predeploy: async () => (await import("./predeploy")).predeployCommand,
	prisma: async () => (await import("./prisma")).prismaCommand,
	files: async () => (await import("./files")).filesCommand,
	secrets: async () => (await import("./secrets")).secretsCommand,
	ci: async () => (await import("./ci")).ciCommand,
	env: async () => (await import("./env")).envCommand,
	url: async () => (await import("./open")).urlCommand,
	open: async () => (await import("./open")).openCommand,
	ls: async () => (await import("./inspect/ls")).lsCommand,
	runs: async () => (await import("./runs")).runsCommand,
	stop: async () => (await import("./stop")).stopCommand,
	restart: async () => (await import("./restart")).restartCommand,
	send: async () => (await import("./send")).sendCommand,
	logs: async () => (await import("./logs")).logsCommand,
	ports: async () => (await import("./ports")).portsCommand,
	sql: async () => (await import("./sql")).sqlCommand,
	status: async () => (await import("./inspect/status")).statusCommand,
	prune: async () => (await import("./prune")).pruneCommand,
	doctor: async () => (await import("./inspect/doctor")).doctorCommand,
	hosts: async () => (await import("./hosts")).hostsCommand,
	bar: async () => (await import("./bar")).barCommand,
	help: async () => (await import("./help")).helpCommand,
	version: async () => (await import("./version")).versionCommand,
} satisfies Record<string, () => Promise<AnyCommand>>;

export type CliCommandName = keyof typeof COMMANDS;

export function loadCommand(name: string): Promise<AnyCommand> | undefined {
	return Object.hasOwn(COMMANDS, name)
		? COMMANDS[name as CliCommandName]()
		: undefined;
}

/** Every top-level command, in help order. */
export function loadAllCommands(): Promise<AnyCommand[]> {
	return Promise.all(Object.values(COMMANDS).map((load) => load()));
}

/**
 * Names agents reach for that mean another command. Not listed in help: each
 * runs its command after a one-line hint naming the real one, so the habit
 * does not spread into docs.
 */
const COMMAND_ALIASES = new Map<string, CliCommandName>([["down", "stop"]]);

export function resolveCommandAlias(value: string): CliCommandName | undefined {
	return COMMAND_ALIASES.get(value);
}
