import type { CommandExample } from "../command-spec";

/**
 * Single source of truth for the top-level commands: `bin.ts` dispatches on
 * `CliCommandName` and `help.ts` renders its listing from `CLI_COMMANDS`.
 */
export const CLI_COMMANDS = [
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
	{ name: "env", usage: "env", summary: "Print environment info as JSON" },
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
		name: "status",
		usage: "status",
		summary: "Show this project's containers, ports, and tunnels",
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
	{ name: "help", usage: "help", summary: "Show this help message" },
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
		description: "Print one value (e.g. ports.api, urls.web)",
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
