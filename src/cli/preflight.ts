import { isInteractive } from "../core/prompt";
import { isCI } from "../core/runtime-flags";
import type { AnyDevEnvironment } from "../types";
import { CliError } from "./errors";
import * as log from "./log";

/**
 * Run the config's and integrations' `preflight` steps, in order, with the
 * real terminal: before the TUI takes the screen, so a step can prompt or
 * run a browser login. A step that throws stops the start with its message.
 */
export async function runPreflight(
	env: AnyDevEnvironment,
	selectedApps: readonly string[],
): Promise<void> {
	const steps = (env.preflight ?? []).filter(
		(step) => !step.apps || step.apps.some((app) => selectedApps.includes(app)),
	);
	// A CI job can have a terminal, and still nobody to log in.
	const interactive = isInteractive() && !isCI();
	for (const step of steps) {
		try {
			await step.run({ root: env.root, env, interactive });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new CliError(`${step.name}: ${message}`);
		}
		log.done(step.name);
	}
}
