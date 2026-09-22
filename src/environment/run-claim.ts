import { basename } from "node:path";
import { getWorktreeName } from "../core/ports";
import { readProcessIdentity } from "../core/process-identity";
import {
	publishRun,
	type RunEntry,
	type RunServiceEntry,
	releaseRun,
} from "../core/run-registry";
import { ensureWatchdog as ensureWatchdogFn } from "../core/watchdog";
import { WATCHDOG_IDLE_TIMEOUT_MS } from "../core/watchdog-constants";
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
	claimRun(options?: { idleTimeoutMs?: number | false }): Promise<void>;
	/** Release the claim: containers are held for the idle timeout, then removed. */
	releaseRun(): Promise<void>;
	/** Start the machine-wide watchdog unless it is already running. */
	ensureWatchdog(): Promise<void>;
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
			const configured = ctx.config.options?.autoShutdown;
			const hold =
				options.idleTimeoutMs ?? configured ?? WATCHDOG_IDLE_TIMEOUT_MS;
			const now = new Date().toISOString();
			const entry: RunEntry = {
				sessionId,
				processIdentity: readProcessIdentity(process.pid),
				projectPrefix: ctx.config.projectPrefix,
				projectName: ctx.projectName,
				root: ctx.root,
				worktree: ctx.worktree
					? (getWorktreeName(ctx.root) ?? basename(ctx.root))
					: null,
				pid: process.pid,
				startedAt: now,
				updatedAt: now,
				...(hold === false ? {} : { idleTimeoutMs: hold }),
				hosts: null,
				cli: { program: process.execPath, script: process.argv[1] },
				apps: [],
				services: serviceEntries(),
			};
			// Claimed before it is published as running: a write that fails must
			// not be retried on every container subset.
			claimed = true;
			await publishRun(entry);
		},

		async releaseRun() {
			// Not guarded on `claimed`: the CLI publishes app-only runs that the
			// library never claimed, and those entries have to be withdrawn by
			// the same call. The registry decides which of the two this is, from
			// whether the entry owns services.
			claimed = false;
			await releaseRun(ctx.root, process.pid, { sessionId });
		},

		ensureWatchdog() {
			return ensureWatchdogFn();
		},
	};
}
