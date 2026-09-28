import { basename } from "node:path";
import {
	acquireLease,
	describeLeaseHolder,
	type LeaseEntry,
} from "../core/leases";
import { askConfirm, isInteractive } from "../core/prompt";
import { readLiveRuns } from "../core/run-registry";
import type { AppConfig } from "../types";
import { stopTarget } from "./commands/stop";
import { CliError } from "./errors";
import * as log from "./log";
import { readGitBranch } from "./run-publish";

interface LeaseOwner {
	sessionId: string;
	projectName: string;
	root: string;
	isWorktree: boolean;
}

async function stopHolder(holder: LeaseEntry): Promise<void> {
	const run = (await readLiveRuns()).find(
		(entry) => entry.sessionId === holder.sessionId,
	);
	// Its run may have ended between the refusal and here; nothing to stop.
	if (run) await stopTarget(run, holder.app, true);
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
	options: { takeover: boolean },
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
		const result = await acquireLease(request);
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

		await stopHolder(result.holder);
		await acquireLease(request, { force: true });
		log.info(`🔑 Took over ${app.exclusive} from ${holder}`);
	}
}
