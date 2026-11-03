import { getErrorMessage } from "hanzio";
import type { AppStateDetail } from "../core/process/run-output";
import { SeedFailedError } from "../environment/seed-startup";
import { CliError } from "./errors";

/**
 * Why a dev run failed, as one block at the end of its output.
 *
 * Agents read `dev | tail`. The run used to put "exited with code 1" first,
 * a warning of a few kilobytes after it and the cause somewhere above, and a
 * failed seeder or an app's `MISSING_SECRETS` was not shown at all. The block
 * names what failed in one line, shows that step's last lines, the setup
 * checks that warned, and what to run next.
 */
export interface RunFailure {
	/** What failed, in one line, naming the app, the seed or the step. */
	cause: string;
	/** Whose output {@link output} is: an app, `seed`. */
	step?: string;
	/** That step's last lines of output. */
	output: readonly string[];
	/** The error's own hints, then the setup checks that warned on this run. */
	hints: readonly string[];
	/** What to run next, each naming its command. */
	next: readonly string[];
}

/** How many of the failing step's last lines the block shows. */
export const FAILURE_OUTPUT_LINES = 20;

/** What the dev flow knows when it fails, filled in as it goes. */
export interface DevFailureContext {
	/** The setup checks that warned before the start, as printed then. */
	setupHints: string[];
	/** The run's app output, once its apps were spawned. */
	output?: {
		tail(app: string): readonly string[];
		readonly states: ReadonlyMap<string, AppStateDetail>;
	};
}

/** The warnings of the setup checks, each line indented under a header. */
function setupHintLines(setupHints: readonly string[]): string[] {
	if (setupHints.length === 0) return [];
	const lines = setupHints.flatMap((hint) => hint.split("\n"));
	return [
		"Setup checks that warned before the start:",
		...lines.map((line) => `  ${line}`),
	];
}

/** The app an error is about: named in its message, else the one that failed. */
function failedApp(
	message: string,
	states: ReadonlyMap<string, AppStateDetail>,
): string | undefined {
	const apps = [...states.keys()];
	const named = apps.find(
		(app) => message.includes(`"${app}"`) || message.startsWith(`${app} `),
	);
	if (named) return named;
	return apps.find((app) => states.get(app)?.state === "failed");
}

/** The block for an error that ended a dev run. */
export function describeDevFailure(
	error: unknown,
	context: DevFailureContext,
): RunFailure {
	const setup = setupHintLines(context.setupHints);
	if (error instanceof SeedFailedError) {
		return {
			cause: `The seed failed with exit code ${error.exitCode}: \`${error.command}\``,
			step: "seed",
			output: error.tail.slice(-FAILURE_OUTPUT_LINES),
			hints: setup,
			next: ["fix it, then `buncargo dev --seed` runs only the seed again"],
		};
	}

	const message = getErrorMessage(error);
	const [cause = "The run failed.", ...rest] = message.split("\n");
	const ownHints = error instanceof CliError ? error.hints : [];
	const { output } = context;
	const app = output && failedApp(message, output.states);
	if (!output || app === undefined)
		return {
			cause,
			output: rest,
			hints: [...ownHints, ...setup],
			next: [],
		};
	return {
		cause,
		step: app,
		output: [...rest, ...output.tail(app)].slice(-FAILURE_OUTPUT_LINES),
		hints: [...ownHints, ...setup],
		next: [`\`buncargo logs ${app}\` has its whole output`],
	};
}

/**
 * The block for an app that never came up while the rest of the run went on
 * (it is parked, not fatal).
 */
export function describeAppFailure(input: {
	app: string;
	reason: string;
	tail: readonly string[];
	setupHints: readonly string[];
}): RunFailure {
	const { app } = input;
	return {
		cause: `${app} did not come up: ${input.reason}`,
		step: app,
		output: input.tail.slice(-FAILURE_OUTPUT_LINES),
		hints: setupHintLines(input.setupHints),
		next: [
			`\`buncargo logs ${app}\` has its whole output; \`buncargo restart ${app}\` starts it again`,
		],
	};
}

/**
 * The block as an error line and the hint lines under it. Multi-line hints
 * (a check's per-variable details) keep their own lines.
 */
export function formatRunFailure(failure: RunFailure): {
	message: string;
	hints: string[];
} {
	const hints: string[] = [];
	if (failure.output.length > 0) {
		const whose = failure.step ? ` of ${failure.step}` : "";
		hints.push(`Last lines${whose}:`);
		for (const line of failure.output) hints.push(`  ${line}`);
	}
	for (const hint of failure.hints) hints.push(...hint.split("\n"));
	for (const command of failure.next) hints.push(`Next: ${command}`);
	return { message: failure.cause, hints };
}
