import {
	appLeaseRequest,
	describeLeaseRefusal,
	endLeaseHolderHint,
	type LeaseOwner,
	type SkippedLeaseApp,
} from "../core/app-leases";
import { acquireLease, releaseLeases } from "../core/leases";
import { formatWarn } from "../core/style";
import type { AppConfig } from "../types";

/**
 * The `exclusive` leases of the apps a library `start()` spawns: the ones
 * `buncargo dev` takes, held by this process until `stop()` or its exit.
 *
 * A script cannot be asked, and there is no `--takeover` for it, so a lease
 * another run holds is answered the way `dev` answers it without a terminal:
 * an `essential: false` app is left out with a warning, and an essential one
 * fails the start, naming the holder and how to end its run.
 */
export async function acquireStartLeases(
	owner: LeaseOwner,
	apps: Record<string, AppConfig>,
	options: { held: ReadonlySet<string>; signal?: AbortSignal },
): Promise<{
	apps: Record<string, AppConfig>;
	/** Keys this call took that the session did not hold before. */
	acquired: string[];
	skipped: SkippedLeaseApp[];
}> {
	const acquired: string[] = [];
	const skipped: SkippedLeaseApp[] = [];

	for (const [name, app] of Object.entries(apps)) {
		if (!app.exclusive) continue;
		const result = await acquireLease(
			appLeaseRequest(owner, name, app.exclusive),
			{ signal: options.signal },
		);
		if (result.ok) {
			if (!options.held.has(app.exclusive)) acquired.push(app.exclusive);
			continue;
		}

		const skip = { app: name, key: app.exclusive, holder: result.holder };
		if (app.essential === false) {
			skipped.push(skip);
			continue;
		}
		// Nothing of this start runs: what it took so far goes back.
		await releaseLeases(owner.sessionId, { keys: acquired });
		throw new Error(
			[
				`${app.exclusive} is in use by another run.`,
				...[
					...describeLeaseRefusal(skip),
					"Only one run may use it at a time.",
					endLeaseHolderHint(skip),
				].map((line) => `  ${line}`),
			].join("\n"),
		);
	}

	for (const skip of skipped) {
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

	const left = new Set(skipped.map((skip) => skip.app));
	return {
		apps: Object.fromEntries(
			Object.entries(apps).filter(([name]) => !left.has(name)),
		),
		acquired,
		skipped,
	};
}
