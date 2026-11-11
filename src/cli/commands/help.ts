import {
	BASE_EXITS,
	commandUsage,
	defineCommand,
	formatExitCodeTable,
	type HelpRow,
} from "../command-spec";
import { CliError } from "../errors";
import {
	integrationCommandRows,
	readAppliedConfig,
} from "../integration-commands";
import { loadAllCommands } from "./registry";
import { formatTaskRows } from "./run";

/** One row per command, from its own spec. */
async function commandRows(): Promise<string[]> {
	const rows: HelpRow[] = (await loadAllCommands()).map((command) =>
		"subcommands" in command
			? {
					command: command.spec.usage ?? `${command.spec.name} <command>`,
					description: `${command.spec.summary} (${Object.keys(command.subcommands).join(" | ")})`,
				}
			: {
					command: commandUsage(command.spec).replace(/^buncargo /, ""),
					description: command.spec.summary,
				},
	);
	const width = Math.max(...rows.map((row) => row.command.length));
	return rows.map((row) =>
		`  ${row.command.padEnd(width)}  ${row.description ?? ""}`.trimEnd(),
	);
}

/** The config's tasks and integration commands, which only it knows. */
async function configSections(): Promise<string> {
	const config = await readAppliedConfig();
	const tasks = config?.tasks ?? {};
	const rows = (config?.integrations ?? []).flatMap(integrationCommandRows);
	const width = Math.max(0, ...rows.map((row) => row.command.length));
	return [
		Object.keys(tasks).length > 0
			? `\nTASKS (bunx buncargo run <task>):\n${formatTaskRows(tasks).join("\n")}\n`
			: "",
		rows.length > 0
			? `\nINTEGRATIONS:\n${rows.map((row) => `  ${row.command.padEnd(width)}  ${row.description}`).join("\n")}\n`
			: "",
	].join("");
}

export async function showHelp(): Promise<void> {
	const [rows, sections] = await Promise.all([commandRows(), configSections()]);
	console.log(`
buncargo - Development environment CLI

USAGE:
  bunx buncargo <command> [options]

COMMANDS:
${rows.join("\n")}

EXAMPLES:
  bunx buncargo dev                     # Start everything
  bunx buncargo dev api                 # Start only api, plus its requiredApps
  bunx buncargo dev --detach            # Start in the background, return once up
  bunx buncargo dev --expose            # Public quick tunnel for expose:true targets
  bunx buncargo dev --down              # Stop containers
  bunx buncargo status --json           # This checkout's runs, ports and containers
  bunx buncargo doctor                  # Diagnose common local-dev problems
  bunx buncargo env --get DATABASE_URL  # One raw value for scripts
  bunx buncargo run db:seed             # Run a task from dev.config.ts
  bunx buncargo ci --migrate -- bun test # Services + migrations in CI
  bunx buncargo help agents             # The guide for AI agents
${sections}
CONFIG:
  Create a dev.config.ts with a default export:

  import { defineDevConfig } from 'buncargo'

  export default defineDevConfig({
    projectPrefix: 'myapp',
    services: { ... },
    apps: { ... }
  })

Run "bunx buncargo <command> --help" for a command's options and exit codes.
`);
}

export const helpCommand = defineCommand({
	spec: {
		name: "help",
		summary: "Show this help message, or the guide for AI agents",
		flags: {},
		args: [
			{ name: "agents", description: "The guide for AI agents" },
			{
				name: "<topic>",
				description: "One topic of it, or all; exits for the exit-code table",
			},
		],
	},
	exits: BASE_EXITS,
	run: async ({ positionals: [guide, topic] }) => {
		if (guide === undefined) {
			await showHelp();
			return 0;
		}
		if (guide !== "agents")
			throw new CliError(`No help for "${guide}".`, [
				`Run "bunx buncargo ${guide} --help" for a command's options.`,
			]);
		const { agentsGuide } = await import("../agents-guide");
		const exitCodes =
			topic === "exits" || topic === "all"
				? formatExitCodeTable(await loadAllCommands())
				: undefined;
		console.log(agentsGuide(topic, exitCodes));
		return 0;
	},
});
