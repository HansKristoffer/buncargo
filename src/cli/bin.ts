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

import { handleSim } from "../expo/sim-command";
import { handleBar } from "./commands/bar";
import { handleBuild } from "./commands/build";
import { handleCi } from "./commands/ci";
import { handleConnect } from "./commands/connect";
import { handleExec } from "./commands/exec";
import { handleGenerate } from "./commands/generate";
import { showHelp } from "./commands/help";
import { handleHosts } from "./commands/hosts";
import { handleDoctor, handleLs, handleStatus } from "./commands/inspect";
import { handlePrune } from "./commands/prune";
import { type CliCommandName, resolveCommandName } from "./commands/registry";
import { handleRun } from "./commands/run";
import { handleRuns } from "./commands/runs";
import {
	handleDev,
	handleEnv,
	handlePrisma,
	handleTypecheck,
} from "./commands/runtime";
import { handleSecrets } from "./commands/secrets";
import { handleSetup } from "./commands/setup";
import { handleStop } from "./commands/stop";
import { showVersion } from "./commands/version";
import { handleWait } from "./commands/wait";
import { CliError } from "./errors";
import { runIntegrationCommand } from "./integration-commands";
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
		case "connect":
			await handleConnect(commandArgs);
			return;
		case "exec":
			process.exitCode = await handleExec(commandArgs);
			return;
		case "run":
			process.exitCode = await handleRun(commandArgs);
			return;
		case "ci":
			process.exitCode = await handleCi(commandArgs);
			return;
		case "wait":
			process.exitCode = await handleWait(commandArgs);
			return;
		case "generate":
			process.exitCode = await handleGenerate(commandArgs);
			return;
		case "build":
			process.exitCode = await handleBuild(commandArgs);
			return;
		case "secrets":
			process.exitCode = await handleSecrets(commandArgs);
			return;
		case "setup":
			process.exitCode = await handleSetup(commandArgs);
			return;
		case "help":
			await showHelp();
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

		case "runs":
			await handleRuns(commandArgs);
			return;

		case "stop": {
			// The only command whose exit code carries meaning to a caller:
			// 2 is "no such target", 3 is "refused", and the menu bar app
			// distinguishes them.
			const code = await handleStop(commandArgs);
			if (code !== 0) process.exit(code);
			return;
		}

		case "prune": {
			const code = await handlePrune(commandArgs);
			if (code !== 0) process.exit(code);
			return;
		}

		case "sim": {
			const code = await handleSim(commandArgs);
			if (code !== 0) process.exit(code);
			return;
		}

		case "status":
			await handleStatus();
			return;

		case "doctor":
			await handleDoctor(commandArgs);
			return;

		case "hosts":
			await handleHosts(commandArgs);
			return;

		case "bar":
			await handleBar(commandArgs);
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
		await showHelp();
		process.exit(0);
	}

	if (VERSION_ALIASES.has(rawCommand)) {
		showVersion();
		process.exit(0);
	}

	const command = resolveCommandName(rawCommand);
	if (!command) {
		// `buncargo shopify url`: an integration's own namespace.
		const code = await runIntegrationCommand(rawCommand, commandArgs);
		if (code !== undefined) {
			process.exitCode = code;
			return;
		}
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
	if (error instanceof CliError) log.fail(error.message, error.hints);
	log.fail(error instanceof Error ? error.message : String(error));
});
