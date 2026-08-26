import {
	CLI_COMMANDS,
	COMMAND_HELP_EXTRAS,
	hostsSubcommandList,
} from "./registry";

function commandRows(): string[] {
	const rows = [
		...CLI_COMMANDS.map((entry) => ({
			command: entry.usage,
			description:
				entry.name === "hosts"
					? `${entry.summary} (${hostsSubcommandList()})`
					: entry.summary,
		})),
		...COMMAND_HELP_EXTRAS,
	];
	const width = Math.max(...rows.map((row) => row.command.length));
	return rows.map((row) =>
		`  ${row.command.padEnd(width)}  ${row.description ?? ""}`.trimEnd(),
	);
}

export function showHelp(): void {
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
