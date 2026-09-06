import type { RunEntry } from "../run-registry";
import { mappingState, type TailnetPeer } from "./client";
import { allocationUrl, leaseTarget } from "./runtime";
import type { TailnetState } from "./state";

export function directorySnapshot(
	self: TailnetPeer,
	state: TailnetState,
	runs: RunEntry[],
	actual: Record<string, unknown>,
	now = Date.now(),
) {
	return {
		version: 1,
		machineId: self.id,
		hostname: self.hostname,
		generatedAt: new Date(now).toISOString(),
		runs: runs.flatMap((run) => {
			const apps = run.apps.flatMap((app) => {
				const allocation = state.allocations.find(
					(a) =>
						a.lease?.root === run.root &&
						a.lease.pid === run.pid &&
						a.lease.app === app.name,
				);
				if (
					!allocation?.lease ||
					mappingState(
						actual,
						allocation.lease.hostname,
						allocation.port,
						leaseTarget(allocation.lease),
					) !== "owned"
				)
					return [];
				return [
					{
						name: app.name,
						status: app.status,
						url: allocationUrl(allocation),
					},
				];
			});
			if (!apps.length) return [];
			return [
				{
					id: run.sessionId ?? `${run.projectName}:${run.startedAt}`,
					project: run.projectPrefix,
					worktree: run.worktree,
					branch: run.branch,
					apps,
				},
			];
		}),
	};
}

export type TailnetSnapshot = ReturnType<typeof directorySnapshot>;
