/**
 * `buncargo prune`: the volumes nothing is using any more.
 *
 * Deliberately separate from the sweep, and deliberately interactive. The
 * sweep removes containers, which cost nothing to recreate; a volume is the
 * database. Nothing may delete one on a heuristic, so this only ever proposes
 * and the person decides.
 *
 * What it can know is narrow. A volume carries Compose's project label and
 * nothing else — buncargo cannot add a label of its own, because Compose
 * compares a volume against the file and offers to recreate it, which is the
 * data loss this exists to prevent. So the checkout a volume belongs to is
 * unknowable, and the strongest honest statement is "no container and no run
 * mentions this project".
 */

import type { RunEntry } from "../core/run-registry";
import type { BuncargoContainer, BuncargoVolume } from "../types";

export type VolumeVerdict =
	/** A container or a run still refers to this project. */
	| { kind: "in-use"; reason: string }
	/** Nothing on this machine refers to it. */
	| { kind: "orphaned" }
	/** The runtime does not say which project it belongs to. */
	| { kind: "unattributed" };

export interface VolumeReport {
	volume: BuncargoVolume;
	verdict: VolumeVerdict;
}

export interface PruneInput {
	volumes: readonly BuncargoVolume[];
	containers: readonly BuncargoContainer[];
	runs: readonly RunEntry[];
}

/**
 * Classify every volume. Pure, so the rule is testable without a daemon.
 *
 * A project that merely stopped still counts as in use: `dev --down` removes
 * containers and retires the entry, and its database has to survive that.
 * Only a project nothing mentions at all is proposed, and even then the
 * caller confirms.
 */
export function planVolumePrune(input: PruneInput): VolumeReport[] {
	const withContainers = new Set(
		input.containers.map((container) => container.project),
	);
	const withRuns = new Set(input.runs.map((run) => run.projectName));

	return input.volumes.map((volume) => {
		if (!volume.project) return { volume, verdict: { kind: "unattributed" } };
		if (withContainers.has(volume.project))
			return {
				volume,
				verdict: { kind: "in-use", reason: "its project has containers" },
			};
		if (withRuns.has(volume.project))
			return {
				volume,
				verdict: { kind: "in-use", reason: "its project has a run on record" },
			};
		return { volume, verdict: { kind: "orphaned" } };
	});
}

export function orphanedVolumes(reports: readonly VolumeReport[]): string[] {
	return reports
		.filter((report) => report.verdict.kind === "orphaned")
		.map((report) => report.volume.name);
}
