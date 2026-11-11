import {
	parseEnvAssignment,
	updateEnvOverrides,
} from "../../core/env-overrides";
import { findCheckoutRoot } from "../../loader";
import { BASE_EXITS, defineCommand } from "../command-spec";
import { argumentsError, CliError } from "../errors";
import * as log from "../log";

/**
 * `buncargo env set` / `env unset`: this checkout's overrides in
 * `.buncargo/env.json`. Take effect on the next run, `exec` or task; a
 * variable set in the shell still wins for that one command.
 */

/** Where `loadDevEnv` reads overrides from, or a file no run would read. */
function checkoutRoot(): string {
	const root = findCheckoutRoot(process.cwd());
	if (!root)
		throw new CliError(
			"No config file found. Run this inside a checkout with a dev.config.ts.",
		);
	return root;
}

export const envSetCommand = defineCommand({
	spec: {
		name: "env set",
		summary:
			"Override a variable for every run, exec and env --export of this checkout",
		flags: {},
		args: [
			{
				name: "KEY=VALUE",
				description: "A variable",
				required: true,
				variadic: true,
			},
		],
		examples: [
			{
				command:
					"bunx buncargo env set UPSTASH_REDIS_REST_URL=http://localhost:8779",
				description:
					"Win over a shared .env.local that points at another checkout",
			},
		],
	},
	exits: BASE_EXITS,
	run: async ({ positionals }) => {
		const set: Record<string, string> = {};
		const errors: string[] = [];
		for (const arg of positionals) {
			const parsed = parseEnvAssignment(arg);
			if ("error" in parsed) errors.push(parsed.error);
			else set[parsed.key] = parsed.value;
		}
		if (errors.length > 0) throw argumentsError(errors, "env set");
		const root = checkoutRoot();
		const now = await updateEnvOverrides(root, { set });
		log.done(`Set ${Object.keys(set).join(", ")} for ${root}`);
		log.hint(
			"Applies from the next run, exec or task. A running dev keeps its environment until restarted.",
		);
		printRemaining(now);
		return 0;
	},
});

export const envUnsetCommand = defineCommand({
	spec: {
		name: "env unset",
		summary: "Drop overrides env set made",
		flags: {},
		args: [
			{
				name: "KEY",
				description: "A variable",
				required: true,
				variadic: true,
			},
		],
	},
	exits: BASE_EXITS,
	run: async ({ positionals }) => {
		const root = checkoutRoot();
		const now = await updateEnvOverrides(root, { unset: [...positionals] });
		log.done(`Unset ${positionals.join(", ")} for ${root}`);
		printRemaining(now);
		return 0;
	},
});

function printRemaining(overrides: Record<string, string>): void {
	const keys = Object.keys(overrides);
	log.info(
		keys.length === 0
			? "No env overrides in this checkout."
			: `Env overrides in this checkout: ${keys.join(", ")}`,
	);
}
