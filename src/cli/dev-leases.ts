import {
	describeLeaseRefusal,
	endLeaseHolderHint,
	type SkippedLeaseApp,
} from "../core/app-leases";
import type { LeaseEntry } from "../core/leases";
import { askConfirm, isInteractive } from "../core/prompt";
import { readLiveRuns } from "../core/run-registry";
import type { LeasePolicy } from "../environment";
import { STOP_EXIT, stopTarget } from "./commands/stop";
import { type TakeoverDecision, takesOver } from "./dev-takeover";
import { CliError } from "./errors";
import * as log from "./log";

async function stopHolder(holder: LeaseEntry): Promise<boolean> {
	const run = (await readLiveRuns()).find(
		(entry) => entry.sessionId === holder.sessionId,
	);
	// A starting app without a pid may still spawn after this check. A free
	// port is not proof that its owner has stopped using the resource.
	const app = run?.apps.find((entry) => entry.name === holder.app);
	if (!run || !app || (app.status === "starting" && app.pid === undefined))
		return false;
	return (await stopTarget(run, holder.app, true)) === STOP_EXIT.ok;
}

/** How to get the lease without guessing: the flag, or ending the other run. */
export function leaseTakeoverHints(skip: SkippedLeaseApp): string[] {
	return [
		`To run ${skip.app} here: buncargo dev --takeover (stops ${skip.app} in that run and moves the lease here)`,
		endLeaseHolderHint(skip, { or: true }),
	];
}

/**
 * The warning a run prints for each app it starts without. Printed before the
 * banner, and again into the TUI's Overview once it owns the screen, where
 * anything printed earlier is out of sight.
 */
export function leaseSkipLines(skip: SkippedLeaseApp): string[] {
	return [
		`Not starting ${skip.app}: ${skip.key} is held by another run.`,
		...describeLeaseRefusal(skip),
		...leaseTakeoverHints(skip),
	];
}

/**
 * How `buncargo dev` answers an `exclusive` lease another live run holds:
 * taken over (an app the run's takeover decision covers, or a `y` to the
 * prompt: stop the holder's app, move the lease here), or left alone. Left
 * alone, an `essential: false` app (the Shopify CLI) is skipped, and the
 * caller drops it and says so; the rest of the run is still worth having. An
 * essential one refuses the run. Either way the message names the holder's
 * checkout and the flag that takes it over: a run that quietly started
 * without the app was the thing to avoid.
 */
export function cliLeasePolicy(options: {
	/** Read at each lease: a takeover earlier in the run widens it. */
	takeover: () => TakeoverDecision;
	/** Test seams; default to the real terminal. */
	interactive?: boolean;
	confirm?: (lines: string[]) => Promise<boolean>;
}): LeasePolicy {
	const interactive = options.interactive ?? isInteractive();
	const confirm = options.confirm ?? askConfirm;
	return {
		takeOver: async (skip, app) => {
			if (takesOver(options.takeover(), skip.app)) return true;
			if (!interactive) return false;
			const optional = app.essential === false;
			return confirm([
				`  ${skip.key} is in use by another run, so ${skip.app} cannot start here.`,
				...describeLeaseRefusal(skip).map((line) => `    ${line}`),
				"",
				`  y to stop ${skip.app} there and run it here  ·  Enter to ${optional ? `start without ${skip.app}` : "cancel"}`,
			]);
		},
		stopHolder,
		refusal: (skip) =>
			new CliError(`${skip.key} is in use by another run.`, [
				...describeLeaseRefusal(skip),
				"Only one run may use it at a time.",
				...leaseTakeoverHints(skip),
			]),
		// Said by the run, before its banner and again in the TUI.
		skipped: () => {},
		tookOver: (key, holder) => log.info(`🔑 Took over ${key} from ${holder}`),
	};
}

/** Print why each skipped app is not starting. */
export function warnSkippedLeaseApps(
	skipped: readonly SkippedLeaseApp[],
): void {
	for (const skip of skipped) {
		const [first = "", ...rest] = leaseSkipLines(skip);
		log.warn(first);
		for (const line of rest) log.hint(line);
	}
}
