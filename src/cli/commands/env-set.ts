import {
	parseEnvAssignment,
	updateEnvOverrides,
} from "../../core/env-overrides";
import { findCheckoutRoot } from "../../loader";
import { type CommandSpec, formatCommandHelp } from "../command-spec";
import { argumentsError, CliError } from "../errors";
import * as log from "../log";

export const ENV_SET_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo env set KEY=VALUE... | buncargo env unset KEY...",
	flags: [
		{ name: "--help", kind: "boolean", description: "Show this help message" },
	],
	notes: [
		{
			command: "set KEY=VALUE...",
			description:
				"Override a variable for every run, exec and env --export of this checkout",
		},
		{ command: "unset KEY...", description: "Drop overrides" },
	],
	examples: [
		{
			command:
				"bunx buncargo env set UPSTASH_REDIS_REST_URL=http://localhost:8779",
			description:
				"Win over a shared .env.local that points at another checkout",
		},
	],
};

/**
 * `buncargo env set` / `env unset`: this checkout's overrides in
 * `.buncargo/env.json`. Takes effect on the next run, `exec` or task; a
 * variable set in the shell still wins for that one command.
 */
export async function handleEnvSet(
	action: "set" | "unset",
	args: string[],
): Promise<void> {
	if (args.includes("--help")) {
		log.line(formatCommandHelp(ENV_SET_COMMAND_SPEC));
		return;
	}
	// Where `loadDevEnv` reads overrides from, or a file no run would read.
	const root = findCheckoutRoot(process.cwd());
	if (!root)
		throw new CliError(
			"No config file found. Run this inside a checkout with a dev.config.ts.",
		);
	if (args.length === 0)
		throw argumentsError(
			[`env ${action} needs at least one variable.`],
			"env set",
		);

	if (action === "unset") {
		const now = await updateEnvOverrides(root, { unset: args });
		log.done(`Unset ${args.join(", ")} for ${root}`);
		printRemaining(now);
		return;
	}

	const set: Record<string, string> = {};
	const errors: string[] = [];
	for (const arg of args) {
		const parsed = parseEnvAssignment(arg);
		if ("error" in parsed) errors.push(parsed.error);
		else set[parsed.key] = parsed.value;
	}
	if (errors.length > 0) throw argumentsError(errors, "env set");
	const now = await updateEnvOverrides(root, { set });
	log.done(`Set ${Object.keys(set).join(", ")} for ${root}`);
	log.hint(
		"Applies from the next run, exec or task. A running dev keeps its environment until restarted.",
	);
	printRemaining(now);
}

function printRemaining(overrides: Record<string, string>): void {
	const keys = Object.keys(overrides);
	log.info(
		keys.length === 0
			? "No env overrides in this checkout."
			: `Env overrides in this checkout: ${keys.join(", ")}`,
	);
}
