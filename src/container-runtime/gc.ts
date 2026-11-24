/**
 * Machine-wide garbage collection planning (`buncargo gc`).
 *
 * Pure decisions built on the existing concern owners: `decideSweep` for
 * orphaned containers and integration stacks, `decideVolume` for deleted
 * checkouts' unused volumes, and `checkoutPresence` for stale port claims.
 */

import type { CheckoutPresence } from "../core/checkout-presence";
import { type OffsetClaim, offsetClaimRoot } from "../core/offset-claims";
import type { RunEntry } from "../core/run-registry";
import { WATCHDOG_OWNER_DEAD_GRACE_MS } from "../core/watchdog-constants";
import type {
	BuncargoContainer,
	BuncargoVolume,
	ContainerRuntimeName,
} from "../types";
import { keepsUnownedStack, parseContainerState } from "./container-state";
import { type ContainerGroup, groupBuncargoContainers } from "./inventory";
import { decideSweep, isKnownStack, runFor } from "./sweep";
import { decideVolume } from "./volume-decision";

export interface GcStackItem {
	projectName: string;
	root: string;
	/** Container runtime name, or an integration stack's name (e.g. `supabase`). */
	runtime: ContainerRuntimeName | string;
	reason: string;
}

interface GcVolumeItem {
	name: string;
	project: string;
	runtime: ContainerRuntimeName;
	root: string;
	reason: string;
}

export interface GcClaimItem {
	key: string;
	root: string;
	projectName: string;
	offset: number;
	reason: string;
}

export interface GcPlan {
	stacks: GcStackItem[];
	volumes: GcVolumeItem[];
	claims: GcClaimItem[];
}

export interface GcPlanInput {
	containers: readonly BuncargoContainer[];
	volumes: readonly BuncargoVolume[];
	runs: readonly RunEntry[];
	alive: (run: RunEntry) => boolean;
	claims: Record<string, OffsetClaim>;
	checkoutPresence: (root: string) => CheckoutPresence;
	lastActivityAt: (group: ContainerGroup) => number | undefined;
	now: number;
	idleLimitMs: number;
}

/**
 * Deleted-checkout port claims safe to drop: their directory is confirmed
 * deleted (`ENOENT`/`ENOTDIR`), and no remaining run, container or volume
 * belongs to their project. Keeping a claim while its volume still stands is
 * what lets a later `gc --yes` or `prune` attribute that volume, and keeping
 * it while a run still stands protects that run's port block.
 */
export function staleDeletedClaims(input: {
	claims: Record<string, OffsetClaim>;
	checkoutPresence: (root: string) => CheckoutPresence;
	remainingRuns: readonly Pick<RunEntry, "projectName" | "root">[];
	remainingContainers: readonly Pick<BuncargoContainer, "project" | "root">[];
	remainingVolumes: readonly Pick<BuncargoVolume, "project">[];
}): GcClaimItem[] {
	const volumeProjects = new Set(
		input.remainingVolumes.flatMap((volume) =>
			volume.project ? [volume.project] : [],
		),
	);
	const items: GcClaimItem[] = [];

	for (const [key, claim] of Object.entries(input.claims)) {
		const root = offsetClaimRoot(key, claim);
		if (input.checkoutPresence(root) !== "deleted") continue;
		const hasRun = input.remainingRuns.some(
			(run) => run.projectName === claim.projectName && run.root === root,
		);
		const hasContainer = input.remainingContainers.some(
			(container) =>
				container.project === claim.projectName && container.root === root,
		);
		if (hasRun || hasContainer || volumeProjects.has(claim.projectName)) {
			continue;
		}

		items.push({
			key,
			root,
			projectName: claim.projectName,
			offset: claim.offset,
			reason: "checkout deleted",
		});
	}

	return items.sort(
		(a, b) => a.offset - b.offset || a.key.localeCompare(b.key),
	);
}

/**
 * Decide everything `buncargo gc` would stop or remove, with no side effects.
 * Mirrors the live execution order: orphaned container and integration stacks
 * first, then volumes that become unreferenced once those stacks are down,
 * then stale deleted-checkout port claims with nothing left on record.
 */
export function planGc(input: GcPlanInput): GcPlan {
	const groups = groupBuncargoContainers([...input.containers]);
	const stacks: GcStackItem[] = [];
	const downed = new Set<string>();
	const stackKey = (projectName: string, root: string) =>
		`${projectName}\t${root}`;
	const limits = {
		ownerDeadGraceMs: WATCHDOG_OWNER_DEAD_GRACE_MS,
		unownedIdleLimitMs: input.idleLimitMs,
	};

	for (const group of groups) {
		const owner = runFor(group, input.runs, input.alive);
		const verdict = decideSweep(
			{
				known: owner !== null || isKnownStack(group, [], input.claims),
				checkout: input.checkoutPresence(group.root),
				anyRunning: group.containers.some((container) =>
					keepsUnownedStack(parseContainerState(container.state)),
				),
				run: owner,
				ownerAlive: owner !== null && input.alive(owner),
				lastActivityAt:
					owner === null ? input.lastActivityAt(group) : undefined,
				now: input.now,
			},
			limits,
		);
		if (verdict.kind !== "down") continue;

		stacks.push({
			projectName: group.projectName,
			root: group.root,
			runtime: group.runtime,
			reason: verdict.reason,
		});
		downed.add(stackKey(group.projectName, group.root));
	}

	const clearedIntegrationSessions = new Set<string>();
	for (const run of input.runs) {
		if (!run.stacks?.length) continue;
		const owner = runFor(run, input.runs, input.alive);
		const verdict = decideSweep(
			{
				known: true,
				checkout: input.checkoutPresence(run.root),
				anyRunning: true,
				run: owner,
				ownerAlive: owner !== null && input.alive(owner),
				now: input.now,
			},
			limits,
		);
		if (verdict.kind !== "down") continue;

		for (const stack of run.stacks) {
			stacks.push({
				projectName: run.projectName,
				root: run.root,
				runtime: stack.name,
				reason: verdict.reason,
			});
		}
		clearedIntegrationSessions.add(run.sessionId);
	}

	const remainingContainers = input.containers.filter(
		(container) => !downed.has(stackKey(container.project, container.root)),
	);
	const remainingRuns = input.runs.filter((run) => {
		if (input.alive(run)) return true;
		if (
			(run.stacks?.length ?? 0) > 0 &&
			!clearedIntegrationSessions.has(run.sessionId)
		) {
			return true;
		}
		return remainingContainers.some(
			(container) =>
				container.project === run.projectName && container.root === run.root,
		);
	});

	const volumeState = {
		containerProjects: new Set(
			remainingContainers.map((container) => container.project),
		),
		runs: remainingRuns.map((run) => ({
			projectName: run.projectName,
			root: run.root,
			deleted: input.checkoutPresence(run.root) === "deleted",
		})),
		checkouts: Object.entries(input.claims).map(([key, claim]) => {
			const root = offsetClaimRoot(key, claim);
			return {
				projectName: claim.projectName,
				root,
				deleted: input.checkoutPresence(root) === "deleted",
				deletedSeenAt: claim.deletedSeenAt,
			};
		}),
	};

	const volumes: GcVolumeItem[] = input.volumes.flatMap((volume) => {
		const decision = decideVolume(volume, volumeState);
		return decision.propose
			? [
					{
						name: volume.name,
						project: volume.project ?? "",
						runtime: volume.runtime,
						root: decision.root,
						reason: decision.reason,
					},
				]
			: [];
	});

	const removedVolumeKeys = new Set(
		volumes.map((volume) => `${volume.runtime}\t${volume.name}`),
	);
	const remainingVolumes = input.volumes.filter(
		(volume) => !removedVolumeKeys.has(`${volume.runtime}\t${volume.name}`),
	);
	const claims = staleDeletedClaims({
		claims: input.claims,
		checkoutPresence: input.checkoutPresence,
		remainingRuns,
		remainingContainers,
		remainingVolumes,
	});

	return { stacks, volumes, claims };
}
