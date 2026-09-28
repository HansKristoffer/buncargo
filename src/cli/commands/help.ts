import {
	integrationCommandRows,
	readAppliedConfig,
} from "../integration-commands";
import {
	barSubcommandList,
	CLI_COMMANDS,
	COMMAND_HELP_EXTRAS,
	hostsSubcommandList,
} from "./registry";
import { formatTaskRows } from "./run";

/** Commands whose subcommands are worth naming in the one-line listing. */
const SUBCOMMAND_LISTS: Record<string, () => string> = {
	hosts: hostsSubcommandList,
	bar: barSubcommandList,
};

function commandRows(): string[] {
	const rows = [
		...CLI_COMMANDS.map((entry) => ({
			command: entry.usage,
			description: SUBCOMMAND_LISTS[entry.name]
				? `${entry.summary} (${SUBCOMMAND_LISTS[entry.name]?.()})`
				: entry.summary,
		})),
		...COMMAND_HELP_EXTRAS,
	];
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
	const sections = await configSections();
	console.log(`
buncargo - Development environment CLI

USAGE:
  bunx buncargo <command> [options]

COMMANDS:
${commandRows().join("\n")}

EXAMPLES:
  bunx buncargo dev                     # Start everything
  bunx buncargo dev --apps=api,platform # Start only selected apps
  bunx buncargo dev --expose            # Public quick tunnel for expose:true targets
  bunx buncargo dev --expose=api        # Public quick tunnel for selected target
  bunx buncargo dev --help              # Show dev command options
  bunx buncargo dev --down              # Stop containers
  bunx buncargo dev --down --all        # Stop every buncargo environment
  bunx buncargo ls                      # List environments
  bunx buncargo status                  # This project's ports and containers
  bunx buncargo doctor                  # Diagnose common local-dev problems
  bunx buncargo hosts status            # Named-hosts daemon and routes
  bunx buncargo hosts install           # One-time CA + :443 proxy (non-interactive)
  bunx buncargo typecheck               # Run typecheck
  bunx buncargo typecheck --only=platform # One workspace
  bunx buncargo typecheck --help        # Typecheck options
  bunx buncargo prisma studio           # Open Prisma Studio
  bunx buncargo env                     # Get ports/urls as JSON
  bunx buncargo env --get ports.api     # One raw value for scripts
  bunx buncargo run db:seed             # Run a task from dev.config.ts
  bunx buncargo ci --migrate -- bun test # Services + migrations in CI
${sections}
CONFIG:
  Create a dev.config.ts with a default export:

  import { defineDevConfig } from 'buncargo'

  export default defineDevConfig({
    projectPrefix: 'myapp',
    services: { ... },
    apps: { ... }
  })

Run "bunx buncargo dev --help" for dev command options.
`);
}
