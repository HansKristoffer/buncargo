import {
	buildRunEntry,
	publishRun,
	type RunServiceEntry,
	releaseRun,
	retireProjectRuns,
} from "../core/run-registry";
import { ensureWatchdog as ensureWatchdogFn } from "../core/watchdog";
import type { AppConfig, ServiceConfig } from "../types";
import type { DevEnvContext } from "./context";

/**
 * A run's claim on its containers.
 *
 * Claiming is how a process says "these containers are mine": an entry in
 * `~/.buncargo/runs.json`, published *before* the first container exists so
 * the sweep can never see a fresh stack as unowned. Releasing marks the entry
 * finished and leaves it there, which is what the idle hold is measured from.
 *
 * The library claims too, not just the CLI. A `dev.start()` from a script
 * owns containers exactly as a `buncargo dev` does, and used to be invisible
 * to everything that reads this registry.
 */
export interface DevRunClaimApi {
	/** The session this environment publishes under. Stable for its lifetime. */
	readonly sessionId: string;
	/**
	 * Claim the selected services' containers for this process.
	 *
	 * Idempotent, so the CLI can claim first with its flags and `start()` can
	 * claim again with the defaults without changing anything.
	 */
	claimRun(options?: ClaimOptions): Promise<void>;
	/** Release the claim: containers are held for the idle timeout, then removed. */
	releaseRun(): Promise<void>;
	/**
	 * Drop the claim outright, after an explicit teardown.
	 *
	 * The containers are gone, so there is nothing to hold: this session's
	 * entry goes, and so does any finished session for the same checkout.
	 * Releasing instead left entries for a later sweep to find empty.
	 */
	retireRun(): Promise<void>;
	/** Start the machine-wide watchdog unless it is already running. */
	ensureWatchdog(): Promise<void>;
}

export interface ClaimOptions {
	/** The hold asked for explicitly; `false` keeps the containers. */
	idleTimeoutMs?: number | false;
	/** The hold when neither this nor `options.autoShutdown` says one. */
	defaultIdleTimeoutMs?: number | false;
}

/**
 * How long a run's containers outlive it, or `undefined` to keep them for as
 * long as the checkout exists.
 *
 * An explicit request wins. Otherwise only a caller that brings a default —
 * the CLI, with its three minutes — gets a hold, and `options.autoShutdown`
 * overrides that default. A library `start()` brings none, so it keeps: a
 * script that brings a database up and ends is indistinguishable, to the
 * sweep, from one that crashed, and any hold would tear its containers down
 * seconds after a perfectly ordinary exit. A script that wants cleanup asks
 * with `claimRun({ idleTimeoutMs })` before starting.
 */
export function resolveClaimHold(
	options: ClaimOptions,
	configured: number | false | undefined,
): number | undefined {
	const hold =
		options.idleTimeoutMs ??
		(options.defaultIdleTimeoutMs === undefined
			? false
			: (configured ?? options.defaultIdleTimeoutMs));
	return hold === false ? undefined : hold;
}

export function createRunClaimApi<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(ctx: DevEnvContext<TServices, TApps>): DevRunClaimApi {
	const sessionId = crypto.randomUUID();
	let claimed = false;

	function serviceEntries(): RunServiceEntry[] {
		return ctx.selectedServiceKeys.map((name) => {
			const service = ctx.services[name] as ServiceConfig | undefined;
			const composeName = service?.serviceName ?? name;
			return {
				name,
				kind: service?.kind,
				status: "starting" as const,
				container: {
					runtime: ctx.runtime.name,
					binary: ctx.runtimeBinary,
					service: composeName,
					name: `${ctx.projectName}-${composeName}`,
				},
			};
		});
	}

	return {
		sessionId,

		async claimRun(options = {}) {
			if (claimed || !ctx.hasSelectedServices) return;
			const hold = resolveClaimHold(options, ctx.config.options?.autoShutdown);
			// Claimed before it is published: a write that fails must not be
			// retried on every container subset.
			claimed = true;
			await publishRun({
				...buildRunEntry({
					sessionId,
					projectPrefix: ctx.config.projectPrefix,
					projectName: ctx.projectName,
					root: ctx.root,
					isWorktree: ctx.worktree,
				}),
				...(hold === undefined ? {} : { idleTimeoutMs: hold }),
				services: serviceEntries(),
			});
		},

		async releaseRun() {
			// Not guarded on `claimed`: the CLI publishes app-only runs that the
			// library never claimed, and those entries have to be withdrawn by
			// the same call. The registry decides which of the two this is, from
			// whether the entry owns services.
			claimed = false;
			await releaseRun(sessionId);
		},

		async retireRun() {
			claimed = false;
			await retireProjectRuns({
				projectName: ctx.projectName,
				root: ctx.root,
				sessionId,
			});
		},

		ensureWatchdog() {
			return ensureWatchdogFn();
		},
	};
}
