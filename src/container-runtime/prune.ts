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
 * known only from this user's port claims, and a volume is proposed only when
 * a claim names its project and that checkout is confirmed deleted
 * ({@link decideVolume}).
 */

import { checkoutDeleted } from "../core/checkout-presence";
import { type OffsetClaim, offsetClaimRoot } from "../core/offset-claims";
import type { RunEntry } from "../core/run-registry";
import type { BuncargoContainer, BuncargoVolume } from "../types";
import {
	type ClaimedCheckout,
	decideVolume,
	type VolumeState,
} from "./volume-decision";

export type VolumeVerdict =
	/** Kept: something refers to its project, or nothing shows its checkout is gone. */
	| { kind: "in-use"; reason: string }
	/** Its checkout, at `root`, was deleted, and nothing else refers to its project. */
	| { kind: "orphaned"; reason: string; root: string }
	/** The runtime does not say which project it belongs to. */
	| { kind: "unattributed"; reason: string };

export interface VolumeReport {
	volume: BuncargoVolume;
	verdict: VolumeVerdict;
}

export interface PruneInput {
	volumes: readonly BuncargoVolume[];
	containers: readonly BuncargoContainer[];
	runs: readonly RunEntry[];
	/** The checkouts this user's port claims name ({@link claimedCheckouts}). */
	checkouts: readonly ClaimedCheckout[];
	/** Only volumes of checkouts deleted this long ago (`prune --older-than`). */
	deletedFor?: VolumeState["deletedFor"];
}

/**
 * Classify every volume by {@link decideVolume}. Pure, so the rule is
 * testable without a daemon.
 */
export function planVolumePrune(input: PruneInput): VolumeReport[] {
	const state = {
		containerProjects: new Set(
			input.containers.map((container) => container.project),
		),
		runs: input.runs.map((run) => ({
			projectName: run.projectName,
			root: run.root,
			deleted: checkoutDeleted(run.root),
		})),
		checkouts: input.checkouts,
		deletedFor: input.deletedFor,
	};
	return input.volumes.map((volume): VolumeReport => {
		const decision = decideVolume(volume, state);
		if (decision.propose)
			return {
				volume,
				verdict: {
					kind: "orphaned",
					reason: decision.reason,
					root: decision.root,
				},
			};
		const kind = volume.project ? "in-use" : "unattributed";
		return { volume, verdict: { kind, reason: decision.reason } };
	});
}

export function orphanedVolumes(reports: readonly VolumeReport[]): string[] {
	return reports
		.filter((report) => report.verdict.kind === "orphaned")
		.map((report) => report.volume.name);
}

/** The checkout each claim names, and whether it is confirmed deleted. */
export function claimedCheckouts(
	claims: Record<string, OffsetClaim>,
): ClaimedCheckout[] {
	return Object.entries(claims).map(([key, claim]) => {
		const root = offsetClaimRoot(key, claim);
		return {
			projectName: claim.projectName,
			root,
			deleted: checkoutDeleted(root),
			deletedSeenAt: claim.deletedSeenAt,
		};
	});
}
