import type { CommandExample } from "../command-spec";

/**
 * Single source of truth for the top-level commands: `bin.ts` dispatches on
 * `CliCommandName` and `help.ts` renders its listing from `CLI_COMMANDS`.
 */
export const CLI_COMMANDS = [
	{
		name: "setup",
		usage: "setup",
		summary: "Run the fix of every failing check",
	},
	{
		name: "run",
		usage: "run [<task>] [-- args]",
		summary: "Run a task from dev.config.ts (lists them without a name)",
	},
	{
		name: "wait",
		usage: "wait --app=<name> [--hold]",
		summary: "Block until an app of this checkout's run is healthy",
	},
	{
		name: "generate",
		usage: "generate",
		summary: "Render generatedFiles without starting anything",
	},
	{
		name: "build",
		usage: "build [--discovered]",
		summary: "Run apps' buildCommand one at a time",
	},
	{
		name: "exec",
		usage: "exec [options] -- <command>",
		summary: "Run a command with the checkout environment",
	},
	{
		name: "connect",
		usage: "connect status",
		summary: "Discover private services through frp",
	},
	{ name: "dev", usage: "dev", summary: "Start the development environment" },
	{
		name: "typecheck",
		usage: "typecheck [options]",
		summary: "Run TypeScript typecheck across workspaces",
	},
	{
		name: "prisma",
		usage: "prisma <args>",
		summary: "Run Prisma CLI with correct DATABASE_URL",
	},
	{
		name: "secrets",
		usage: "secrets ls [--app=<name>]",
		summary: "List Infisical keys and where each comes from (never values)",
	},
	{
		name: "ci",
		usage: "ci [--migrate] [--seed] [-- <command>]",
		summary: "Start services in CI, prepare them, run a command, tear down",
	},
	{
		name: "env",
		usage: "env [--get <path>] [--export]",
		summary: "Print environment info as JSON, including injected vars",
	},
	{
		name: "url",
		usage: "url [<name>]",
		summary: "Print an app's or a captured URL (lists them without a name)",
	},
	{
		name: "open",
		usage: "open [<name>]",
		summary: "Open the primary app, or any URL `url` lists",
	},
	{
		name: "ls",
		usage: "ls",
		summary: "List every buncargo environment on this machine",
	},
	{
		name: "runs",
		usage: "runs [--json]",
		summary: "Show the dev runs active on this machine",
	},
	{
		name: "stop",
		usage: "stop [<name>...] [--all]",
		summary: "Stop one app or service, or a whole run",
	},
	{
		name: "restart",
		usage: "restart <app>",
		summary:
			"Restart one app of a running dev (e.g. a stopped non-essential one)",
	},
	{
		name: "send",
		usage: "send <app> <keys> [--enter]",
		summary: "Type into an app that has a terminal (e.g. Expo's i)",
	},
	{
		name: "logs",
		usage: "logs [<app>] [-f] [--since=5m] [--errors]",
		summary: "Read app output from the current or last run",
	},
	{
		name: "ports",
		usage: "ports [pin <offset>]",
		summary: "Show this checkout's ports and every offset; pin one",
	},
	{
		name: "sql",
		usage: "sql [<service>] [-c <query>] [--json] [--create-scratch=<name>]",
		summary: "Open the database's own client in this checkout's container",
	},
	{
		name: "sim",
		usage: "sim [<app>]",
		summary: "Open this checkout's Expo app in its own iOS simulator",
	},
	{
		name: "status",
		usage: "status [--json]",
		summary: "Show this project's containers, ports, and tunnels",
	},
	{
		name: "prune",
		usage: "prune [--dry-run] [--yes]",
		summary: "Remove volumes whose project is gone (destroys their data)",
	},
	{
		name: "doctor",
		usage: "doctor",
		summary: "Check Docker, port owners, lockfile, hosts, and orphans",
	},
	{
		name: "hosts",
		usage: "hosts <subcommand>",
		summary: "Named .localhost URLs",
	},
	{
		name: "bar",
		usage: "bar <subcommand>",
		summary: "The BuncargoBar menu bar app",
	},
	{
		name: "help",
		usage: "help [agents]",
		summary: "Show this help message, or the guide for AI agents",
	},
	{ name: "version", usage: "version", summary: "Show version" },
] as const satisfies readonly {
	name: string;
	usage: string;
	summary: string;
}[];

export type CliCommandName = (typeof CLI_COMMANDS)[number]["name"];

const COMMAND_NAMES = new Set<string>(CLI_COMMANDS.map((entry) => entry.name));

export function resolveCommandName(
	value: string | undefined,
): CliCommandName | undefined {
	if (value === undefined) return undefined;
	return COMMAND_NAMES.has(value) ? (value as CliCommandName) : undefined;
}

/** Extra `<command> <flag>` forms worth showing in the root help listing. */
export const COMMAND_HELP_EXTRAS: readonly CommandExample[] = [
	{
		command: "env --get <path>",
		description: "Print one value (e.g. ports.api, urls.web, DATABASE_URL)",
	},
	{
		command: "env --export",
		description:
			'Injected vars as shell exports: eval "$(buncargo env --export)"',
	},
	{
		command: "doctor --fix",
		description: "Repair named-hosts daemon, CA trust, and stale routes",
	},
	{
		command: "typecheck --only=<workspaces>",
		description: "Typecheck selected workspaces (path or basename)",
	},
	{
		command: "dev --profile=<name>",
		description: "Run a profile's apps from dev.config.ts",
	},
	{
		command: "prisma migrate-check",
		description: "Fail when migrations and schema.prisma differ",
	},
	{
		command: "runs --json",
		description: "Machine-readable view of every active run",
	},
];

export const HOSTS_SUBCOMMANDS = [
	{ name: "install", summary: "One-time CA + :443 proxy (non-interactive)" },
	{ name: "status", summary: "Daemon health, CA, and active routes" },
	{ name: "sync", summary: "Rewrite the /etc/hosts buncargo block" },
	{ name: "prune", summary: "Drop routes whose owner process is gone" },
	{ name: "uninstall", summary: "Remove named hosts from this machine" },
	{ name: "daemon", summary: "Run the loopback HTTPS proxy in the foreground" },
] as const satisfies readonly { name: string; summary: string }[];

export type HostsSubcommand = (typeof HOSTS_SUBCOMMANDS)[number]["name"];

const HOSTS_SUBCOMMAND_NAMES = new Set<string>(
	HOSTS_SUBCOMMANDS.map((entry) => entry.name),
);

export function resolveHostsSubcommand(
	value: string,
): HostsSubcommand | undefined {
	return HOSTS_SUBCOMMAND_NAMES.has(value)
		? (value as HostsSubcommand)
		: undefined;
}

export function hostsSubcommandList(): string {
	return HOSTS_SUBCOMMANDS.map((entry) => entry.name).join(" | ");
}

export const BAR_SUBCOMMANDS = [
	{ name: "install", summary: "Download and install the menu bar app" },
	{ name: "update", summary: "Update the app to the latest release" },
	{ name: "status", summary: "Installed version, and whether it is running" },
	{ name: "open", summary: "Open the app, installing it first if needed" },
	{ name: "uninstall", summary: "Quit and remove the app" },
	{ name: "reset", summary: "Offer the app again after declining it" },
] as const satisfies readonly { name: string; summary: string }[];

export type BarSubcommand = (typeof BAR_SUBCOMMANDS)[number]["name"];

const BAR_SUBCOMMAND_NAMES = new Set<string>(
	BAR_SUBCOMMANDS.map((entry) => entry.name),
);

export function resolveBarSubcommand(value: string): BarSubcommand | undefined {
	return BAR_SUBCOMMAND_NAMES.has(value) ? (value as BarSubcommand) : undefined;
}

export function barSubcommandList(): string {
	return BAR_SUBCOMMANDS.map((entry) => entry.name).join(" | ");
}
