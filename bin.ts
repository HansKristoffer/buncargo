#!/usr/bin/env bun

/**
 * CLI Entry Point for buncargo
 *
 * Usage:
 *   bunx buncargo dev           # Start containers + dev servers
 *   bunx buncargo dev --down    # Stop containers
 *   bunx buncargo dev --reset   # Stop + remove volumes
 *   bunx buncargo prisma ...    # Run prisma commands
 *   bunx buncargo help          # Show help
 */

import { runCli } from "./cli";
import { loadDevEnv } from "./loader";

/**
 * Load the dev environment with CLI-friendly error output.
 */
async function loadEnv() {
	try {
		return await loadDevEnv();
	} catch (error) {
		console.error(`❌ ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Command Handlers
// ═══════════════════════════════════════════════════════════════════════════

async function handleDev(args: string[]): Promise<void> {
	const env = await loadEnv();
	await runCli(env, { args });
}

async function handlePrisma(args: string[]): Promise<void> {
	const env = await loadEnv();

	if (!env.prisma) {
		console.error("❌ Prisma is not configured in your dev config.");
		console.error("");
		console.error("   Add prisma to your config:");
		console.error("");
		console.error("   export default defineDevConfig({");
		console.error("     ...");
		console.error("     prisma: {");
		console.error("       cwd: 'packages/prisma'");
		console.error("     }");
		console.error("   })");
		process.exit(1);
	}

	// Ensure database is running
	const running = await env.isRunning();
	if (!running) {
		console.log("🐳 Starting database container...");
		await env.start({ startServers: false, wait: true });
	}

	const exitCode = await env.prisma.run(args);
	process.exit(exitCode);
}

async function handleEnv(): Promise<void> {
	const env = await loadEnv();
	console.log(
		JSON.stringify(
			{
				projectName: env.projectName,
				ports: env.ports,
				urls: env.urls,
				portOffset: env.portOffset,
				isWorktree: env.isWorktree,
				localIp: env.localIp,
				root: env.root,
			},
			null,
			2,
		),
	);
}

function showHelp(): void {
	console.log(`
buncargo - Development environment CLI

USAGE:
  bunx buncargo <command> [options]

COMMANDS:
  dev                 Start the development environment
  prisma <args>       Run Prisma CLI with correct DATABASE_URL
  env                 Print environment info as JSON
  help                Show this help message
  version             Show version

DEV OPTIONS:
  --up-only           Start containers only (no dev servers)
  --down              Stop containers
  --reset             Stop containers and remove volumes
  --migrate           Run migrations only
  --seed              Run seeders
  --lint              Run typecheck (no Docker required)

EXAMPLES:
  bunx buncargo dev              # Start everything
  bunx buncargo dev --down       # Stop containers
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
`);
}

function showVersion(): void {
	const pkg = require("./package.json");
	console.log(`buncargo v${pkg.version}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];
	const commandArgs = args.slice(1);

	if (
		!command ||
		command === "help" ||
		command === "--help" ||
		command === "-h"
	) {
		showHelp();
		process.exit(0);
	}

	if (command === "version" || command === "--version" || command === "-v") {
		showVersion();
		process.exit(0);
	}

	switch (command) {
		case "dev":
			await handleDev(commandArgs);
			break;

		case "prisma":
			await handlePrisma(commandArgs);
			break;

		case "env":
			await handleEnv();
			break;

		default:
			console.error(`❌ Unknown command: ${command}`);
			console.error("");
			console.error('   Run "bunx buncargo help" for available commands.');
			process.exit(1);
	}
}

main().catch((error) => {
	console.error("❌ Fatal error:", error);
	process.exit(1);
});
