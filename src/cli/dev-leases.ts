import { basename } from "node:path";
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
import { readGitBranch } from "./run-publish";

interface LeaseOwner {
	sessionId: string;
	projectName: string;
	root: string;
	isWorktree: boolean;
}

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

/**
 * Take the lease of every app about to spawn that declares `exclusive`.
 *
 * A lease held by another live run is refused with who holds it, or taken
 * over: `--takeover`, or a `y` to the prompt, stops the holder's app and
 * moves the lease here. Like the port takeover, a bare Enter leaves it alone.
 */
export async function acquireAppLeases(
	owner: LeaseOwner,
	apps: Record<string, AppConfig>,
	options: { takeover: boolean; signal?: AbortSignal },
): Promise<void> {
	for (const [name, app] of Object.entries(apps)) {
		if (!app.exclusive) continue;
		const request = {
			key: app.exclusive,
			sessionId: owner.sessionId,
			app: name,
			projectName: owner.projectName,
			root: owner.root,
			worktree: owner.isWorktree ? basename(owner.root) : null,
			branch: readGitBranch(owner.root),
		};
		const result = await acquireLease(request, { signal: options.signal });
		if (result.ok) continue;

		const holder = describeLeaseHolder(result.holder);
		const takeOver =
			options.takeover ||
			(isInteractive() &&
				(await askConfirm([
					`  ${app.exclusive} is in use by ${holder}.`,
					"",
					`  y to stop it there and run ${name} here  ·  Enter to leave it`,
				])));
		if (!takeOver) {
			throw new CliError(`${app.exclusive} is in use by ${holder}.`, [
				"Only one run may use it at a time.",
				"Pass --takeover to stop it there and run it here.",
			]);
		}

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
}
