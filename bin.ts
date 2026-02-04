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

import { existsSync } from "node:fs";
import { runCli } from "./cli";
import { createDevEnvironment } from "./environment";
import type { AppConfig, DevEnvironment, ServiceConfig } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Config Discovery
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG_FILES = [
	"dev.config.ts",
	"dev.config.js",
	"dev-tools.config.ts",
	"dev-tools.config.js",
];

/**
 * Find and load the dev config file from the current directory.
 * Returns the DevEnvironment created from the config.
 */
async function loadEnv(): Promise<
	DevEnvironment<Record<string, ServiceConfig>, Record<string, AppConfig>>
> {
	const cwd = process.cwd();

	for (const file of CONFIG_FILES) {
		const path = `${cwd}/${file}`;
		const exists = existsSync(path);

		if (exists) {
			try {
				const mod = await import(path);
				const config = mod.default;

				if (!config) {
					console.error(
						`❌ Config file "${file}" found but no default export.`,
					);
					console.error("");
					console.error("   Export your config as default:");
					console.error("");
					console.error("   import { defineDevConfig } from 'buncargo'");
					console.error("");
					console.error("   export default defineDevConfig({ ... })");
					process.exit(1);
				}

				// Validate it looks like a config
				if (!config.projectPrefix || !config.services) {
					console.error(`❌ Config file "${file}" is not a valid dev config.`);
					console.error("");
					console.error("   Make sure to use defineDevConfig:");
					console.error("");
					console.error("   export default defineDevConfig({");
					console.error("     projectPrefix: 'myapp',");
					console.error("     services: { ... }");
					console.error("   })");
					process.exit(1);
				}

				// Create environment from config
				return createDevEnvironment(config);
			} catch (error) {
				console.error(`❌ Failed to load config file "${file}":`);
				console.error(error);
				process.exit(1);
			}
		}
	}

	console.error("❌ No config file found.");
	console.error("");
	console.error("   Create a dev.config.ts file in your project root:");
	console.error("");
	console.error("   import { defineDevConfig } from 'buncargo'");
	console.error("");
	console.error("   export default defineDevConfig({");
	console.error("     projectPrefix: 'myapp',");
	console.error("     services: {");
	console.error('       postgres: { port: 5432, healthCheck: "pg_isready" }');
	console.error("     }");
	console.error("   })");
	console.error("");
	console.error("   Supported config files:");
	for (const file of CONFIG_FILES) {
		console.error(`     - ${file}`);
	}
	process.exit(1);
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
