/**
 * Whether one volume may be proposed for removal.
 *
 * A volume is the database, so it needs positive evidence, never an absence
 * of it: this user's state must name the volume's project, and the checkout
 * that named it must be confirmed deleted. An idle checkout has no container
 * and no run, and its claim in `offsets.json` is the only thing saying its
 * volume is in use; a claims file that could not be read made every idle
 * checkout's database look orphaned.
 *
 * The one owner of that rule: `prune`, the watchdog's orphan report, `doctor`
 * and the sweep's settling of deleted checkouts all decide here.
 */

import type { BuncargoVolume } from "../types";

/** A checkout a port claim names, and whether its directory is confirmed gone. */
export interface ClaimedCheckout {
	projectName: string;
	root: string;
	/** Confirmed missing (`ENOENT`); a directory this user cannot read is not. */
	deleted?: boolean;
	/** When the sweep first found it deleted (`OffsetClaim.deletedSeenAt`). */
	deletedSeenAt?: string;
}

export interface VolumeState {
	/** Compose projects that still have a container. */
	containerProjects: ReadonlySet<string>;
	/** The checkouts with a run on record, live or released, and their projects. */
	runs: readonly ClaimedCheckout[];
	/** Every checkout this user's port claims name, suffixed ones included. */
	checkouts: readonly ClaimedCheckout[];
	/**
	 * Propose only once every checkout naming the project was first found
	 * deleted at least `ms` before `now`: the sweep's wait before it removes
	 * on its own, and `prune --older-than`.
	 */
	deletedFor?: { ms: number; now: number };
}

export type VolumeDecision =
	/** `root` is the deleted checkout whose claim named the volume's project. */
	| { propose: true; reason: string; root: string }
	/**
	 * `wait` is true while something that passes keeps it (a container, a
	 * run, a deletion too recent), so a later look may propose it.
	 */
	| { propose: false; reason: string; wait: boolean };

/** Pure: the rule every volume removal and report shares. */
export function decideVolume(
	volume: BuncargoVolume,
	state: VolumeState,
): VolumeDecision {
	const keep = (reason: string, wait = false): VolumeDecision => ({
		propose: false,
		reason,
		wait,
	});
	const project = volume.project;
	if (!project)
		return keep("the runtime does not say which project it belongs to");
	if (state.containerProjects.has(project))
		return keep("its project has containers", true);
	// A run from a checkout that is gone is retired soon; one from a checkout
	// that exists runs under the name without a claim (`BUNCARGO_PORT_OFFSET`).
	const runs = state.runs.filter((run) => run.projectName === project);
	if (runs.length > 0)
		return keep(
			"its project has a run on record",
			runs.every((run) => run.deleted),
		);
	const named = state.checkouts.filter(
		(checkout) => checkout.projectName === project,
	);
	const existing = named.find((checkout) => !checkout.deleted);
	if (existing) return keep(`its checkout ${existing.root} still exists`);
	const [deleted] = named;
	if (!deleted) return keep("no checkout on record names its project");
	const { deletedFor } = state;
	if (deletedFor) {
		const recent = named.find((checkout) => {
			const seen = Date.parse(checkout.deletedSeenAt ?? "");
			return Number.isNaN(seen) || deletedFor.now - seen < deletedFor.ms;
		});
		if (recent)
			return keep(
				`its checkout ${recent.root} was found deleted less than ${formatSpan(deletedFor.ms)} ago`,
				true,
			);
	}
	return {
		propose: true,
		reason: `its checkout ${deleted.root} was deleted`,
		root: deleted.root,
	};
}

/** `7d`, `12h`, `10m`: the largest whole unit. */
export function formatSpan(ms: number): string {
	for (const [unit, size] of [
		["d", 86_400_000],
		["h", 3_600_000],
		["m", 60_000],
	] as const)
		if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
	return `${Math.ceil(ms / 1000)}s`;
}
