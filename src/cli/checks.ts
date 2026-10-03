import type { CheckContext, SetupCheck } from "../types";
import { CliError } from "./errors";

export interface CheckResult {
	check: SetupCheck;
	ok: boolean;
	/** Why it failed: the check's own detail, or what it threw. */
	detail?: string;
	/** This result's severity, when the check set one for it. */
	severity?: "error" | "warning";
}

/**
 * Run checks at once and return every result, in the order given.
 *
 * A check that throws counts as failed: it is a precondition, and one that
 * cannot even be evaluated is not met.
 */
export async function runChecks(
	checks: readonly SetupCheck[],
	ctx: CheckContext,
): Promise<CheckResult[]> {
	return Promise.all(
		checks.map(async (check): Promise<CheckResult> => {
			try {
				const outcome = await check.check(ctx);
				return typeof outcome === "boolean"
					? { check, ok: outcome }
					: {
							check,
							ok: outcome.ok,
							detail: outcome.detail,
							severity: outcome.severity,
						};
			} catch (error) {
				return {
					check,
					ok: false,
					detail: error instanceof Error ? error.message : String(error),
				};
			}
		}),
	);
}

export function isWarning(result: CheckResult): boolean {
	return (result.severity ?? result.check.severity) === "warning";
}

/** How to fix a failed check, as one line. */
function describeFix(check: SetupCheck): string | undefined {
	if (typeof check.fix === "string") return `run \`${check.fix}\``;
	if (check.fix)
		return check.fixDescription ?? "`bunx buncargo setup` can fix it";
	return undefined;
}

/** Hint lines naming what failed and how to fix it. */
export function describeCheckFailures(
	results: readonly CheckResult[],
): string[] {
	return results.map((result) => {
		const reason = result.detail ? ` (${result.detail})` : "";
		const fix = describeFix(result.check);
		return `${result.check.name}${reason}${fix ? `: ${fix}` : ""}`;
	});
}

/** What `buncargo dev` throws when the checkout is not ready to start. */
export function checkFailureError(failures: readonly CheckResult[]): CliError {
	const hints = describeCheckFailures(failures);
	if (failures.some((failure) => failure.check.fix)) {
		hints.push("Or run `bunx buncargo setup` to run every fix.");
	}
	return new CliError(
		`${failures.length === 1 ? "A check" : `${failures.length} checks`} failed before starting:`,
		hints,
	);
}
