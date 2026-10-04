import { findMonorepoRoot } from "../../core/ports";
import { askChoice, isInteractive } from "../../core/prompt";
import { isCI } from "../../core/runtime-flags";
import { loadDevEnv } from "../../loader";
import type { AnyDevEnvironment, CheckContext, SetupCheck } from "../../types";
import { writeAgentsBlock } from "../agents-guide";
import {
	type CheckResult,
	describeCheckFailures,
	isWarning,
	runChecks,
} from "../checks";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
} from "../command-spec";
import { allChecks } from "../core-checks";
import { argumentsError, CliError } from "../errors";
import * as log from "../log";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	yes: {
		name: "--yes",
		kind: "boolean",
		description: "Run every fix without asking (implied in CI)",
	},
	agents: {
		name: "--agents",
		kind: "boolean",
		description:
			"Add or update the buncargo block in AGENTS.md (pointing at `help agents`), then exit",
	},
} as const;

export const SETUP_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo setup [--yes] [--agents]",
	flags: Object.values(FLAGS),
	examples: [
		{
			command: "bunx buncargo setup",
			description: "Check the checkout and offer each fix",
		},
	],
};

function printResult(result: CheckResult): void {
	const detail = result.detail ? ` (${result.detail})` : "";
	if (result.ok) log.done(result.check.name);
	else if (isWarning(result)) log.warn(`${result.check.name}${detail}`);
	else log.error(`${result.check.name}${detail}`);
}

/** How a fix is described in the question and the log. */
function fixLabel(check: SetupCheck): string {
	return typeof check.fix === "string"
		? `\`${check.fix}\``
		: (check.fixDescription ?? "the fix");
}

async function applyFix(check: SetupCheck, ctx: CheckContext): Promise<void> {
	if (typeof check.fix === "string") {
		const result = await ctx.env.exec(check.fix, {
			verbose: true,
			throwOnError: false,
		});
		if (result.exitCode !== 0)
			throw new Error(`exited with code ${result.exitCode}`);
		return;
	}
	await check.fix?.(ctx);
}

/**
 * Make the checkout ready: every check (core, config, integrations), in order,
 * offering each failing one's fix. Idempotent: a passing checkout changes
 * nothing. Fixes run one at a time in check order, because a later fix may
 * need an earlier one's output.
 *
 * Interactive by default; `--yes` and CI run every fix. A terminal-less run
 * without `--yes` only reports, rather than guessing consent.
 */
export async function handleSetup(args: string[]): Promise<number> {
	if (readBooleanFlag(args, FLAGS.help)) {
		console.log(formatCommandHelp(SETUP_COMMAND_SPEC));
		return 0;
	}
	const unknown = [
		...findUnknownFlags(SETUP_COMMAND_SPEC, args),
		...readPositionals(SETUP_COMMAND_SPEC, args),
	];
	if (unknown.length > 0) {
		throw argumentsError(
			[`Unexpected argument: ${unknown.join(" ")}`],
			"setup",
		);
	}

	if (readBooleanFlag(args, FLAGS.agents)) {
		const { path, changed } = writeAgentsBlock(findMonorepoRoot());
		if (changed) log.done(`Updated the buncargo block in ${path}`);
		else log.done(`${path} is up to date`);
		return 0;
	}

	const env = (await loadDevEnv({ readOnly: true })) as AnyDevEnvironment;
	const ctx: CheckContext = { root: env.root, env };
	const checks = allChecks(env);
	const autoFix = readBooleanFlag(args, FLAGS.yes) || isCI();
	const canAsk = !autoFix && isInteractive();

	const results = await runChecks(checks, ctx);
	for (const result of results) printResult(result);

	let skipped = 0;
	for (const result of results) {
		const { check } = result;
		if (result.ok || !check.fix) continue;
		const accepted =
			autoFix ||
			(canAsk &&
				(await askChoice(
					[`  Fix "${check.name}": run ${fixLabel(check)}? [Y/n]`],
					[
						{ key: "", value: true },
						{ key: "y", value: true },
						{ key: "yes", value: true },
					],
					false,
				)));
		if (!accepted) {
			skipped++;
			continue;
		}
		log.info(`🔧 ${check.name}: ${fixLabel(check)}`);
		try {
			await applyFix(check, ctx);
		} catch (error) {
			log.error(
				`Fix for "${check.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// Checked again rather than trusting the fixes: a fix that exits 0 but
	// leaves the check failing is exactly what setup exists to report.
	const failing = results.filter((result) => !result.ok);
	const after = await runChecks(
		failing.map((result) => result.check),
		ctx,
	);
	const errors = after.filter((result) => !result.ok && !isWarning(result));
	const warnings = after.filter((result) => !result.ok && isWarning(result));

	log.line();
	if (errors.length === 0) {
		log.success(
			warnings.length > 0
				? `Ready, with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`
				: `All ${checks.length} checks pass.`,
		);
		return 0;
	}

	throw new CliError(
		`${errors.length} check${errors.length === 1 ? "" : "s"} still failing:`,
		[
			...describeCheckFailures(errors),
			...(skipped > 0 && !canAsk
				? ["Run `bunx buncargo setup --yes` to apply the fixes."]
				: []),
		],
	);
}
