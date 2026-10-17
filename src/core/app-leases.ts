import { basename } from "node:path";
import {
	describeLeaseHolder,
	type LeaseEntry,
	type LeaseRequest,
} from "./leases";
import { readGitBranch } from "./run-publish";

/**
 * Exclusive leases as a run sees them: which apps take one, and how a run
 * explains a lease another run holds. `buncargo dev` and a library `start()`
 * take the same leases and name the holder in the same words.
 */

/** The run taking a lease. */
export interface LeaseOwner {
	sessionId: string;
	projectName: string;
	root: string;
	isWorktree: boolean;
}

/** An app a run does not start because another run holds its lease. */
export interface SkippedLeaseApp {
	app: string;
	key: string;
	holder: LeaseEntry;
}

/** The lease `app` takes for `owner`. */
export function appLeaseRequest(
	owner: LeaseOwner,
	app: string,
	key: string,
): LeaseRequest {
	return {
		key,
		sessionId: owner.sessionId,
		app,
		projectName: owner.projectName,
		root: owner.root,
		worktree: owner.isWorktree ? basename(owner.root) : null,
		branch: readGitBranch(owner.root),
	};
}

function formatSince(acquiredAt: string, now: Date): string | undefined {
	const at = new Date(acquiredAt);
	if (Number.isNaN(at.getTime())) return undefined;
	const minutes = Math.max(
		0,
		Math.round((now.getTime() - at.getTime()) / 60_000),
	);
	const ago =
		minutes < 1
			? "just now"
			: minutes < 120
				? `${minutes} min ago`
				: `${Math.round(minutes / 60)} h ago`;
	// Local HH:MM, the same whatever the locale.
	return `${at.toTimeString().slice(0, 5)} (${ago})`;
}

/**
 * Who holds a lease and where, as the lines under a refusal, a skip or the
 * takeover prompt: the checkout path is what lets someone find the other
 * terminal, which the project name alone does not when every worktree has it.
 */
export function describeLeaseRefusal(
	skip: SkippedLeaseApp,
	options: { now?: Date } = {},
): string[] {
	const { holder } = skip;
	const since = formatSince(holder.acquiredAt, options.now ?? new Date());
	return [
		`Held by:  ${describeLeaseHolder(holder)}`,
		`Checkout: ${holder.root}`,
		...(since ? [`Since:    ${since}`] : []),
	];
}

/**
 * Ending the holder's run: the way to the lease that needs no takeover, and
 * the only one a run without a terminal or `--takeover` has.
 */
export function endLeaseHolderHint(
	skip: SkippedLeaseApp,
	options: { or?: boolean } = {},
): string {
	return `${options.or ? "Or end" : "End"} that run first: Ctrl-C in its terminal, or buncargo stop --all --root ${skip.holder.root}`;
}
