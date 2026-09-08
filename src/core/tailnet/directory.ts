import type { RunEntry } from "../run-registry";
import { mappingState, type TailnetPeer } from "./client";
import type { RemoteDirectory } from "./protocol";
import { allocationUrl, leaseMatchesRun, leaseTarget } from "./runtime";
import type { TailnetState } from "./state";

/**
 * Build the JSON document the coordinator serves at `/v1/runs`.
 *
 * Only includes apps whose Serve mapping is live and matches the recorded
 * lease — stale reservations and foreign mappings are omitted.
 */
export function directorySnapshot(
	self: TailnetPeer,
	state: TailnetState,
	runs: RunEntry[],
	actual: Record<string, unknown>,
	now = Date.now(),
): RemoteDirectory {
	return {
		version: 1,
		machineId: self.id,
		hostname: self.hostname,
		generatedAt: new Date(now).toISOString(),
		runs: runs.flatMap((run) => {
			const apps = run.apps.flatMap((app) => {
				const allocation = state.allocations.find(
					(a) =>
						a.lease &&
						leaseMatchesRun(a.lease, run) &&
						a.lease.app === app.name,
				);

				if (
					!state.enabled ||
					state.removing ||
					!allocation?.lease ||
					allocation.lease.pendingRemoval ||
					mappingState(
						actual,
						allocation.lease.hostname,
						allocation.port,
						leaseTarget(allocation.lease),
					) !== "owned"
				) {
					return [];
				}

				const url = allocationUrl(allocation);
				if (!url) return [];

				return [
					{
						name: app.name,
						status: app.status,
						url,
					},
				];
			});

			if (!apps.length) return [];

			// Match the local menu's primary selection before filtering shared apps.
			// An unshared primary must not silently promote another app, such as an API.
			const primary =
				run.apps.find((app) => app.name === run.primaryApp) ?? run.apps[0];
			const primaryApp =
				apps.find((app) => app.name === primary?.name)?.name ?? null;

			return [
				{
					id: run.sessionId ?? `${run.projectName}:${run.startedAt}`,
					project: run.projectPrefix,
					worktree: run.worktree,
					branch: run.branch,
					primaryApp,
					apps,
				},
			];
		}),
	};
}

export type TailnetSnapshot = ReturnType<typeof directorySnapshot>;
