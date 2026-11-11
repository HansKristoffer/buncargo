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
import { noteCheckoutCommand } from "../core/run-activity";
import { findCheckoutRoot } from "../loader/find-config-file";
import { runCommand } from "./command-spec";
import { loadCommand, resolveCommandAlias } from "./commands/registry";
import { toCliError } from "./errors";
import * as log from "./log";
import { guardVersion } from "./version-guard";

const HELP_ALIASES = new Set(["--help", "-h"]);
const VERSION_ALIASES = new Set(["--version", "-v"]);

function failWith(error: unknown): never {
	const failure = toCliError(error);
	log.fail(failure.message, failure.hints);
}

/**
 * Run `buncargo <args>`. buncargo reads only its first argument as the
 * command: `--help x` is help and `--json runs` is an unknown command.
 */
async function dispatch(args: readonly string[]): Promise<number> {
	const [first = "help", ...rest] = args;
	const name = HELP_ALIASES.has(first)
		? "help"
		: VERSION_ALIASES.has(first)
			? "version"
			: first;
	const command = loadCommand(name);
	if (command) return runCommand(await command, name === first ? rest : []);

	const alias = resolveCommandAlias(first);
	if (alias) {
		log.hint(
			`\`buncargo ${first}\` is \`buncargo ${alias}\`; use \`buncargo ${alias}\`.`,
		);
		return dispatch([alias, ...rest]);
	}
	// A name that is no command may be an integration's namespace (`buncargo shopify env`).
	const code = first.startsWith("-")
		? undefined
		: await (
				await import("./integration-commands")
			).runIntegrationCommand(first, rest);
	if (code !== undefined) return code;
	log.fail(`Unknown command: ${first}`, [
		'Run "bunx buncargo help" for available commands.',
	]);
}

async function main(): Promise<void> {
	// The file locks, process groups and port lookups are POSIX-only, so fail
	// here once instead of deep inside a command.
	if (process.platform === "win32")
		log.fail("buncargo runs on macOS and Linux.", [
			"On Windows, run buncargo in WSL.",
		]);

	// `<package>/src/cli` from source, `<package>/dist/cli` when installed.
	const cliDir = dirname(fileURLToPath(import.meta.url));
	await guardVersion(basename(dirname(cliDir)) === "src");

	const args = process.argv.slice(2);
	const first = args[0];

	// A command in a checkout is the checkout in use: a detached run's idle
	// limit counts from it (`core/run-activity.ts`). One `utimes`, no fork.
	const usesCheckout =
		first !== undefined &&
		!first.startsWith("-") &&
		first !== "help" &&
		first !== "version";
	const root = usesCheckout ? findCheckoutRoot(process.cwd()) : undefined;
	if (root !== undefined) noteCheckoutCommand(root);

	const code = await dispatch(args);
	// Exit now on failure: the code means something to the caller, and a
	// handle left open must not keep the process alive past it.
	if (code !== 0) process.exit(code);
}

main().catch(failWith);
