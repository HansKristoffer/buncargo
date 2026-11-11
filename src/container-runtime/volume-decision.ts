/**
 * Whether one volume may be proposed for removal.
 *
 * A volume is the database, so it needs positive evidence, never an absence
 * of it: this user's state must name the volume's project, and the checkout
 * that named it must be confirmed deleted. An idle checkout has no container
 * and no run, and its claim in `offsets.json` is the only thing saying its
 * volume is in use; a claims file that could not be read made every idle
 * checkout's database look orphaned.
 */

import type { BuncargoVolume } from "../types";

/** A checkout a port claim names, and whether its directory is confirmed gone. */
export interface ClaimedCheckout {
	projectName: string;
	root: string;
	/** Confirmed missing (`ENOENT`); a directory this user cannot read is not. */
	deleted?: boolean;
}

export interface VolumeState {
	/** Compose projects that still have a container. */
	containerProjects: ReadonlySet<string>;
	/** Projects with a run on record, live or released. */
	runProjects: ReadonlySet<string>;
	/** Every checkout this user's port claims name, suffixed ones included. */
	checkouts: readonly ClaimedCheckout[];
}

export type VolumeDecision =
	/** `root` is the deleted checkout whose claim named the volume's project. */
	| { propose: true; reason: string; root: string }
	| { propose: false; reason: string };

/** Pure: the rule `prune` and the watchdog's orphan report share. */
export function decideVolume(
	volume: BuncargoVolume,
	state: VolumeState,
): VolumeDecision {
	const project = volume.project;
	if (!project)
		return {
			propose: false,
			reason: "the runtime does not say which project it belongs to",
		};
	if (state.containerProjects.has(project))
		return { propose: false, reason: "its project has containers" };
	if (state.runProjects.has(project))
		return { propose: false, reason: "its project has a run on record" };
	const named = state.checkouts.filter(
		(checkout) => checkout.projectName === project,
	);
	const existing = named.find((checkout) => !checkout.deleted);
	if (existing)
		return {
			propose: false,
			reason: `its checkout ${existing.root} still exists`,
		};
	const [deleted] = named;
	if (!deleted)
		return {
			propose: false,
			reason: "no checkout on record names its project",
		};
	return {
		propose: true,
		reason: `its checkout ${deleted.root} was deleted`,
		root: deleted.root,
	};
}
