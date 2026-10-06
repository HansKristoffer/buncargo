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

import { type CliCommandName, resolveCommandName } from "./commands/registry";
import { CliError } from "./errors";
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
			await (await import("./commands/connect")).handleConnect(commandArgs);
			return;
		case "exec":
			process.exitCode = await (await import("./commands/exec")).handleExec(
				commandArgs,
			);
			return;
		case "slot":
			process.exitCode = await (await import("./commands/slot")).handleSlot(
				commandArgs,
			);
			return;
		case "run":
			process.exitCode = await (await import("./commands/run")).handleRun(
				commandArgs,
			);
			return;
		case "ci":
			process.exitCode = await (await import("./commands/ci")).handleCi(
				commandArgs,
			);
			return;
		case "wait":
			process.exitCode = await (await import("./commands/wait")).handleWait(
				commandArgs,
			);
			return;
		case "url":
			process.exitCode = await (await import("./commands/open")).handleUrl(
				commandArgs,
			);
			return;
		case "open":
			process.exitCode = await (await import("./commands/open")).handleOpen(
				commandArgs,
			);
			return;
		case "generate":
			process.exitCode = await (
				await import("./commands/generate")
			).handleGenerate(commandArgs);
			return;
		case "build":
			process.exitCode = await (await import("./commands/build")).handleBuild(
				commandArgs,
			);
			return;
		case "secrets":
			process.exitCode = await (
				await import("./commands/secrets")
			).handleSecrets(commandArgs);
			return;
		case "setup":
			process.exitCode = await (await import("./commands/setup")).handleSetup(
				commandArgs,
			);
			return;
		case "help":
			if (commandArgs[0] === "agents") {
				console.log((await import("./agents-guide")).AGENTS_GUIDE);
				return;
			}
			await (await import("./commands/help")).showHelp();
			return;

		case "version":
			(await import("./commands/version")).showVersion();
			return;

		case "dev":
			await (await import("./commands/runtime")).handleDev(commandArgs);
			return;

		case "typecheck":
			await (await import("./commands/runtime")).handleTypecheck(commandArgs);
			return;

		case "prisma":
			await (await import("./commands/runtime")).handlePrisma(commandArgs);
			return;

		case "env":
			await (await import("./commands/runtime")).handleEnv(commandArgs);
			return;

		case "ls":
			await (await import("./commands/inspect")).handleLs();
			return;

		case "runs":
			await (await import("./commands/runs")).handleRuns(commandArgs);
			return;

		case "stop": {
			// The only command whose exit code carries meaning to a caller:
			// 2 is "no such target", 3 is "refused", and the menu bar app
			// distinguishes them.
			const code = await (await import("./commands/stop")).handleStop(
				commandArgs,
			);
			if (code !== 0) process.exit(code);
			return;
		}

		case "restart":
			process.exitCode = await (
				await import("./commands/restart")
			).handleRestart(commandArgs);
			return;

		case "send":
			process.exitCode = await (await import("./commands/send")).handleSend(
				commandArgs,
			);
			return;

		case "ports":
			process.exitCode = await (await import("./commands/ports")).handlePorts(
				commandArgs,
			);
			return;

		case "sql":
			process.exitCode = await (await import("./commands/sql")).handleSql(
				commandArgs,
			);
			return;

		case "logs":
			process.exitCode = await (await import("./commands/logs")).handleLogs(
				commandArgs,
			);
			return;

		case "prune": {
			const code = await (await import("./commands/prune")).handlePrune(
				commandArgs,
			);
			if (code !== 0) process.exit(code);
			return;
		}

		case "sim": {
			const code = await (await import("../expo/sim-command")).handleSim(
				commandArgs,
			);
			if (code !== 0) process.exit(code);
			return;
		}

		case "status":
			await (await import("./commands/inspect")).handleStatus(commandArgs);
			return;

		case "doctor":
			await (await import("./commands/inspect")).handleDoctor(commandArgs);
			return;

		case "hosts":
			await (await import("./commands/hosts")).handleHosts(commandArgs);
			return;

		case "bar":
			await (await import("./commands/bar")).handleBar(commandArgs);
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
		await (await import("./commands/help")).showHelp();
		process.exit(0);
	}

	if (VERSION_ALIASES.has(rawCommand)) {
		(await import("./commands/version")).showVersion();
		process.exit(0);
	}

	const command = resolveCommandName(rawCommand);
	if (!command) {
		// `buncargo shopify env`: an integration's own namespace.
		const code = await (
			await import("./integration-commands")
		).runIntegrationCommand(rawCommand, commandArgs);
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
