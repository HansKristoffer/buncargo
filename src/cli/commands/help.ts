export function showHelp(): void {
	console.log(`
buncargo - Development environment CLI

USAGE:
  bunx buncargo <command> [options]

COMMANDS:
  dev                 Start the development environment
  typecheck           Run TypeScript typecheck across workspaces
  prisma <args>       Run Prisma CLI with correct DATABASE_URL
  env                 Print environment info as JSON
  help                Show this help message
  version             Show version

EXAMPLES:
  bunx buncargo dev              # Start everything
  bunx buncargo dev --apps=api,platform # Start only selected apps
  bunx buncargo dev --expose     # Public quick tunnel for expose:true targets
  bunx buncargo dev --expose=api # Public quick tunnel for selected target
  bunx buncargo dev --help       # Show dev command options
  bunx buncargo dev --down       # Stop containers
  bunx buncargo typecheck        # Run typecheck
  bunx buncargo prisma studio    # Open Prisma Studio
  bunx buncargo env              # Get ports/urls as JSON

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
