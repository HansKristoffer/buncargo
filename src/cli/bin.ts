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

import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Command, defineCli, defineCommand } from "hanzio/cli";
import { type CliCommandName, resolveCommandName } from "./commands/registry";
import { CliError } from "./errors";
import * as log from "./log";
import { guardVersion } from "./version-guard";

const HELP_ALIASES = new Set(["--help", "-h"]);
const VERSION_ALIASES = new Set(["--version", "-v"]);

function failWith(error: unknown): never {
	if (error instanceof CliError) log.fail(error.message, error.hints);
	log.fail(error instanceof Error ? error.message : String(error));
}

/**
 * Each command parses its own arguments and prints its own help, so hanzio/cli
 * only dispatches: `raw` hands over everything after the command name. A
 * returned number becomes the exit code; errors print the way they always have.
 */
function command(handler: (args: string[]) => Promise<unknown>): Command {
	return defineCommand({
		raw: true,
		run: async (_input, ctx) => {
			try {
				const code = await handler([...ctx.argv]);
				if (typeof code === "number") process.exitCode = code;
			} catch (error) {
				failWith(error);
			}
		},
	});
}

/** Exit now on failure: these codes mean something to a caller. */
function exitOnFailure(code: number): void {
	if (code !== 0) process.exit(code);
}

const COMMANDS = {
	connect: command(async (args) =>
		(await import("./commands/connect")).handleConnect(args),
	),
	exec: command(async (args) =>
		(await import("./commands/exec")).handleExec(args),
	),
	slot: command(async (args) =>
		(await import("./commands/slot")).handleSlot(args),
	),
	check: command(async (args) =>
		(await import("./commands/check/index")).handleCheck(args),
	),
	predeploy: command(async (args) =>
		(await import("./commands/predeploy")).handlePredeploy(args),
	),
	run: command(async (args) =>
		(await import("./commands/run")).handleRun(args),
	),
	ci: command(async (args) => (await import("./commands/ci")).handleCi(args)),
	wait: command(async (args) =>
		(await import("./commands/wait")).handleWait(args),
	),
	url: command(async (args) =>
		(await import("./commands/open")).handleUrl(args),
	),
	open: command(async (args) =>
		(await import("./commands/open")).handleOpen(args),
	),
	generate: command(async (args) =>
		(await import("./commands/generate")).handleGenerate(args),
	),
	build: command(async (args) =>
		(await import("./commands/build")).handleBuild(args),
	),
	files: command(async (args) =>
		(await import("./commands/files")).handleFiles(args),
	),
	secrets: command(async (args) =>
		(await import("./commands/secrets")).handleSecrets(args),
	),
	setup: command(async (args) =>
		(await import("./commands/setup")).handleSetup(args),
	),
	help: command(async (args) => {
		if (args[0] === "agents") {
			console.log((await import("./agents-guide")).AGENTS_GUIDE);
		} else {
			await (await import("./commands/help")).showHelp();
		}
		process.exit(0);
	}),
	version: command(async () => {
		(await import("./commands/version")).showVersion();
		process.exit(0);
	}),
	dev: command(async (args) =>
		(await import("./commands/runtime")).handleDev(args),
	),
	typecheck: command(async (args) =>
		(await import("./commands/runtime")).handleTypecheck(args),
	),
	prisma: command(async (args) =>
		(await import("./commands/runtime")).handlePrisma(args),
	),
	env: command(async (args) =>
		(await import("./commands/runtime")).handleEnv(args),
	),
	ls: command(async () => (await import("./commands/inspect")).handleLs()),
	runs: command(async (args) =>
		(await import("./commands/runs")).handleRuns(args),
	),
	// 2 is "no such target", 3 is "refused"; the menu bar app tells them apart.
	stop: command(async (args) =>
		exitOnFailure(await (await import("./commands/stop")).handleStop(args)),
	),
	restart: command(async (args) =>
		(await import("./commands/restart")).handleRestart(args),
	),
	send: command(async (args) =>
		(await import("./commands/send")).handleSend(args),
	),
	ports: command(async (args) =>
		(await import("./commands/ports")).handlePorts(args),
	),
	sql: command(async (args) =>
		(await import("./commands/sql")).handleSql(args),
	),
	logs: command(async (args) =>
		(await import("./commands/logs")).handleLogs(args),
	),
	prune: command(async (args) =>
		exitOnFailure(await (await import("./commands/prune")).handlePrune(args)),
	),
	status: command(async (args) =>
		(await import("./commands/inspect")).handleStatus(args),
	),
	doctor: command(async (args) =>
		(await import("./commands/inspect")).handleDoctor(args),
	),
	hosts: command(async (args) =>
		(await import("./commands/hosts")).handleHosts(args),
	),
	bar: command(async (args) =>
		(await import("./commands/bar")).handleBar(args),
	),
} satisfies Record<CliCommandName, Command>;

const cli = defineCli({ name: "buncargo", commands: COMMANDS });

async function main(): Promise<void> {
	// `<package>/src/cli` from source, `<package>/dist/cli` when installed.
	const cliDir = dirname(fileURLToPath(import.meta.url));
	guardVersion(basename(dirname(cliDir)) === "src");

	const args = process.argv.slice(2);
	const rawCommand = args[0];

	// The root's help, version and unknown commands keep buncargo's own
	// output: the help lists the config's tasks and integrations, and an
	// unknown name may be an integration's namespace (`buncargo shopify env`).
	if (!rawCommand || HELP_ALIASES.has(rawCommand)) {
		await (await import("./commands/help")).showHelp();
		process.exit(0);
	}
	if (VERSION_ALIASES.has(rawCommand)) {
		(await import("./commands/version")).showVersion();
		process.exit(0);
	}
	if (!resolveCommandName(rawCommand)) {
		const code = await (
			await import("./integration-commands")
		).runIntegrationCommand(rawCommand, args.slice(1));
		if (code !== undefined) {
			process.exitCode = code;
			return;
		}
		log.fail(`Unknown command: ${rawCommand}`, [
			'Run "bunx buncargo help" for available commands.',
		]);
	}

	const code = await cli.run(args);
	if (code !== 0) process.exitCode = code;
}

main().catch(failWith);
