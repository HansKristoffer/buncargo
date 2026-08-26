#!/usr/bin/env bun

/**
 * CLI Entry Point for buncargo
 *
 * Usage:
 *   bunx buncargo dev           # Start containers + dev servers
 *   bunx buncargo dev --down    # Stop containers
 *   bunx buncargo dev --reset   # Stop + remove volumes
 *   bunx buncargo typecheck     # Run TypeScript typecheck
 *   bunx buncargo prisma ...    # Run prisma commands
 *   bunx buncargo help          # Show help
 */

import { showHelp } from "./commands/help";
import { handleHosts } from "./commands/hosts";
import { handleDoctor, handleLs, handleStatus } from "./commands/inspect";
import { type CliCommandName, resolveCommandName } from "./commands/registry";
import {
	handleDev,
	handleEnv,
	handlePrisma,
	handleTypecheck,
} from "./commands/runtime";
import { showVersion } from "./commands/version";
import * as log from "./log";

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

const HELP_ALIASES = new Set(["--help", "-h"]);
const VERSION_ALIASES = new Set(["--version", "-v"]);

async function runCommand(
	command: CliCommandName,
	commandArgs: string[],
): Promise<void> {
	switch (command) {
		case "help":
			showHelp();
			return;

		case "version":
			showVersion();
			return;

		case "dev":
			await handleDev(commandArgs);
			return;

		case "typecheck":
			await handleTypecheck(commandArgs);
			return;

		case "prisma":
			await handlePrisma(commandArgs);
			return;

		case "env":
			await handleEnv(commandArgs);
			return;

		case "ls":
			await handleLs();
			return;

		case "status":
			await handleStatus();
			return;

		case "doctor":
			await handleDoctor(commandArgs);
			return;

		case "hosts":
			await handleHosts(commandArgs);
			return;

		default: {
			const exhaustive: never = command;
			throw new Error(`Unhandled command: ${String(exhaustive)}`);
		}
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const rawCommand = args[0];
	const commandArgs = args.slice(1);

	if (!rawCommand || HELP_ALIASES.has(rawCommand)) {
		showHelp();
		process.exit(0);
	}

	if (VERSION_ALIASES.has(rawCommand)) {
		showVersion();
		process.exit(0);
	}

	const command = resolveCommandName(rawCommand);
	if (!command) {
		log.fail(`Unknown command: ${rawCommand}`, [
			'Run "bunx buncargo help" for available commands.',
		]);
	}

	await runCommand(command, commandArgs);
	if (command === "help" || command === "version") {
		process.exit(0);
	}
}

main().catch((error: unknown) => {
	log.fail(error instanceof Error ? error.message : String(error));
});
