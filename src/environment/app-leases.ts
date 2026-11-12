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
	releaseLeases,
	transferLease,
} from "../core/leases";
import { formatWarn } from "../core/style";
import type { ResolvedApp } from "../types";

/**
 * How a start answers an `exclusive` lease another run holds. `buncargo dev`
 * asks, or takes it over with `--takeover`; a library `start()` cannot ask
 * ({@link libraryLeasePolicy}).
 */
export interface LeasePolicy {
	/** Take the lease over: stop the holder's app and move the lease here. */
	takeOver(skip: SkippedLeaseApp, app: ResolvedApp): Promise<boolean>;
	/** Stop the holder's app; true once it has stopped. */
	stopHolder(holder: LeaseEntry): Promise<boolean>;
	/** The error that ends the start when an essential app's lease is held. */
	refusal(skip: SkippedLeaseApp): Error;
	/** Said once the leases are taken, for the `essential: false` apps left out. */
	skipped(skips: readonly SkippedLeaseApp[]): void;
	/** A lease this start took over. */
	tookOver(key: string, holder: string): void;
}

/**
 * A script cannot be asked, and there is no `--takeover` for it, so a lease
 * another run holds is answered the way `dev` answers it without a terminal:
 * an `essential: false` app is left out with a warning, and an essential one
 * fails the start, naming the holder and how to end its run.
 */
export const libraryLeasePolicy: LeasePolicy = {
	takeOver: async () => false,
	stopHolder: async () => false,
	refusal: (skip) =>
		new Error(
			[
				`${skip.key} is in use by another run.`,
				...[
					...describeLeaseRefusal(skip),
					"Only one run may use it at a time.",
					endLeaseHolderHint(skip),
				].map((line) => `  ${line}`),
			].join("\n"),
		),
	skipped: (skips) => {
		for (const skip of skips) {
			console.warn(
				formatWarn(
					`Not starting ${skip.app}: ${skip.key} is held by another run.`,
				),
			);
			for (const line of [
				...describeLeaseRefusal(skip),
				endLeaseHolderHint(skip),
			])
				console.warn(`   ${line}`);
		}
	},
	tookOver: () => {},
};

/**
 * Take the `exclusive` lease of every app about to spawn, the ones held by
 * this session's process until it releases them or exits.
 *
 * A lease another live run holds goes to `policy`: taken over, or left
 * alone. Left alone, an `essential: false` app is skipped and returned so
 * the caller can drop it and say so; an essential one refuses the start and
 * gives back what this call took.
 */
export async function acquireStartLeases(
	owner: LeaseOwner,
	apps: Record<string, ResolvedApp>,
	options: {
		held: ReadonlySet<string>;
		policy: LeasePolicy;
		signal?: AbortSignal;
	},
): Promise<{
	apps: Record<string, ResolvedApp>;
	/** Keys this call took that the session did not hold before. */
	acquired: string[];
	skipped: SkippedLeaseApp[];
}> {
	const { policy, signal } = options;
	const acquired: string[] = [];
	const skipped: SkippedLeaseApp[] = [];
	const took = (key: string) => {
		if (!options.held.has(key)) acquired.push(key);
	};

	for (const [name, app] of Object.entries(apps)) {
		if (!app.exclusive) continue;
		const request = appLeaseRequest(owner, name, app.exclusive);
		const result = await acquireLease(request, { signal });
		if (result.ok) {
			took(app.exclusive);
			continue;
		}

		const skip = { app: name, key: app.exclusive, holder: result.holder };
		if (!(await policy.takeOver(skip, app))) {
			if (app.essential === false) {
				skipped.push(skip);
				continue;
			}
			// Nothing of this start runs: what it took so far goes back.
			await releaseLeases(owner.sessionId, { keys: acquired });
			throw policy.refusal(skip);
		}

		const holder = describeLeaseHolder(result.holder);
		const transferred = await transferLease(
			request,
			result.holder,
			policy.stopHolder,
			{ signal },
		);
		if (!transferred.ok) {
			await releaseLeases(owner.sessionId, { keys: acquired });
			throw new Error(
				transferred.reason === "stop-refused"
					? `Could not stop ${app.exclusive} held by ${holder}.`
					: `${app.exclusive} ownership changed during takeover. Retry to check its current owner.`,
			);
		}
		took(app.exclusive);
		policy.tookOver(app.exclusive, holder);
	}

	if (skipped.length > 0) policy.skipped(skipped);
	const left = new Set(skipped.map((skip) => skip.app));
	return {
		apps: Object.fromEntries(
			Object.entries(apps).filter(([name]) => !left.has(name)),
		),
		acquired,
		skipped,
	};
}
