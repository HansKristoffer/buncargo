import {
	appLeaseRequest,
	describeLeaseRefusal,
	endLeaseHolderHint,
	type LeaseOwner,
	type SkippedLeaseApp,
} from "../core/app-leases";
import {
	acquireLease,
	describeLeaseHolder,
	type LeaseEntry,
	transferLease,
} from "../core/leases";
import { askConfirm, isInteractive } from "../core/prompt";
import { readLiveRuns } from "../core/run-registry";
import type { AppConfig } from "../types";
import { STOP_EXIT, stopTarget } from "./commands/stop";
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
 * Take the lease of every app about to spawn that declares `exclusive`.
 *
 * A lease held by another live run is taken over (`--takeover`, or a `y` to
 * the prompt: stop the holder's app, move the lease here), or left alone. Left
 * alone, an `essential: false` app — the Shopify CLI — is skipped, and
 * returned so the caller can drop it and say so; the rest of the run is still
 * worth having. An essential one refuses the run, as before. Either way the
 * message names the holder's checkout and the flag that takes it over: a run
 * that quietly started without the app was the thing to avoid.
 */
export async function acquireAppLeases(
	owner: LeaseOwner,
	apps: Record<string, AppConfig>,
	options: {
		takeover: boolean;
		signal?: AbortSignal;
		/** Test seams; default to the real terminal. */
		interactive?: boolean;
		confirm?: (lines: string[]) => Promise<boolean>;
	},
): Promise<{ skipped: SkippedLeaseApp[] }> {
	const interactive = options.interactive ?? isInteractive();
	const confirm = options.confirm ?? askConfirm;
	const skipped: SkippedLeaseApp[] = [];

	for (const [name, app] of Object.entries(apps)) {
		if (!app.exclusive) continue;
		const request = appLeaseRequest(owner, name, app.exclusive);
		const result = await acquireLease(request, { signal: options.signal });
		if (result.ok) continue;

		const skip = { app: name, key: app.exclusive, holder: result.holder };
		const optional = app.essential === false;
		const takeOver =
			options.takeover ||
			(interactive &&
				(await confirm([
					`  ${app.exclusive} is in use by another run, so ${name} cannot start here.`,
					...describeLeaseRefusal(skip).map((line) => `    ${line}`),
					"",
					`  y to stop ${name} there and run it here  ·  Enter to ${optional ? `start without ${name}` : "cancel"}`,
				])));

		if (!takeOver) {
			if (!optional) {
				throw new CliError(`${app.exclusive} is in use by another run.`, [
					...describeLeaseRefusal(skip),
					"Only one run may use it at a time.",
					...leaseTakeoverHints(skip),
				]);
			}
			skipped.push(skip);
			continue;
		}

		const holder = describeLeaseHolder(result.holder);
		const transferred = await transferLease(
			request,
			result.holder,
			stopHolder,
			{
				signal: options.signal,
			},
		);
		if (!transferred.ok) {
			throw new CliError(
				transferred.reason === "stop-refused"
					? `Could not stop ${app.exclusive} held by ${holder}.`
					: `${app.exclusive} ownership changed during takeover. Retry to check its current owner.`,
			);
		}
		log.info(`🔑 Took over ${app.exclusive} from ${holder}`);
	}

	return { skipped };
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
