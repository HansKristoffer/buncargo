/**
 * The watchdog's orphaned-volume report: the volumes `buncargo prune` would
 * propose, said in the watchdog's log.
 *
 * Report only. A volume is the database, so nothing here removes one: the
 * only removals are a confirmed `buncargo prune` and a machine's opt-in for
 * deleted checkouts (see AGENTS.md). Without the opt-in, the volumes of a
 * deleted checkout build up until someone runs `prune` by hand.
 */

import { type OffsetClaim, readAllOffsetClaims } from "../core/offset-claims";
import { type RunEntry, readAllRuns } from "../core/run-registry";
import type { ContainerRuntimeName } from "../types";
import { buncargoContainersOn } from "./containers";
import { claimedCheckouts, orphanedVolumes, planVolumePrune } from "./prune";
import { containerRuntimeCandidates } from "./resolve";
import type { ContainerRuntimeAdapter } from "./types";

/**
 * How often the report is made. It lists every volume on the machine, which
 * the sweep does not need to do every pass.
 */
export const ORPHAN_VOLUME_REPORT_INTERVAL_MS = 60 * 60_000;

/** How soon a pass that could not read a runtime or the registry is made again. */
export const ORPHAN_VOLUME_REPORT_RETRY_MS = 5 * 60_000;

export interface OrphanVolumeReportDeps {
	log: (message: string) => void;
	/** The runtimes to ask. Defaults to every backend. */
	runtimes?: () => ContainerRuntimeAdapter[];
	readRuns?: () => Promise<RunEntry[]>;
	claims?: () => Record<string, OffsetClaim>;
	now?: () => number;
}

/**
 * A reporter for the sweep. Each call is a no-op until the interval has passed,
 * and it logs only when the set of orphaned volumes has changed since the last
 * report, so a standing set is said once rather than every hour.
 *
 * `answered` is the runtimes the sweep reached this pass. Only their volumes
 * are judged, and only against their own containers, so a runtime that is not
 * installed or not up neither adds to the report nor hides anything in it.
 */
export function orphanVolumeReporter(deps: OrphanVolumeReportDeps) {
	const runtimes = deps.runtimes ?? containerRuntimeCandidates;
	const readRuns = deps.readRuns ?? readAllRuns;
	const claims = deps.claims ?? readAllOffsetClaims;
	const now = deps.now ?? Date.now;
	let nextAt = 0;
	let reported: string | undefined;

	return async function report(
		answered: readonly ContainerRuntimeName[],
	): Promise<void> {
		const startedAt = now();
		if (startedAt < nextAt) return;

		const active = runtimes().filter((runtime) =>
			answered.includes(runtime.name),
		);
		// Nothing listed is no pass: the hour starts when one is made.
		if (active.length === 0) return;
		// A pass that fails tries again soon, not an hour later.
		nextAt = startedAt + ORPHAN_VOLUME_REPORT_RETRY_MS;
		try {
			const containers = (
				await Promise.all(
					active.map((runtime) => buncargoContainersOn(runtime)),
				)
			).flat();
			const volumes = (
				await Promise.all(active.map((runtime) => runtime.listVolumes()))
			).flat();
			const names = orphanedVolumes(
				planVolumePrune({
					volumes,
					containers,
					runs: await readRuns(),
					checkouts: claimedCheckouts(claims()),
				}),
			);
			nextAt = startedAt + ORPHAN_VOLUME_REPORT_INTERVAL_MS;
			const key = names.join("\n");
			if (key === reported) return;
			reported = key;
			if (names.length === 0) return;
			deps.log(
				`${names.length} volume${names.length === 1 ? "" : "s"} belong${names.length === 1 ? "s" : ""} to deleted checkouts, with no container and no run: ${names.join(", ")}. Review them with \`bunx buncargo prune --dry-run\`; nothing is removed automatically.`,
			);
		} catch {
			// A registry or runtime that cannot be read this pass is reported by
			// the sweep itself, or is back on the next one.
		}
	};
}
