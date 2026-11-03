import { pick } from "hanzio";
import { readClaimStates } from "../container-runtime";
import {
	markOffsetClaimsReclaimed,
	offsetClaimHolder,
} from "../core/offset-claims";
import {
	type ClaimState,
	chooseReclaim,
	formatClaimAge,
	PortBlockExhaustedError,
} from "../core/port-exhaustion";
import { formatWarn } from "../core/style";

/**
 * How many blocks one start may reclaim. Each attempt frees one block; a run
 * that raced for it, or a block another config's claims also touch, costs
 * one more. More than this and the range is not stale, it is in use.
 */
const MAX_PORT_RECLAIMS = 3;

/**
 * Run a claiming allocation; when the range is full, reclaim the block of
 * the checkout started least recently that has no run and no containers, say
 * whose, and run it again. What `prepareStartAsync` allocates through, so
 * `dev`, `start()`, `ci` and the prisma path all reclaim.
 *
 * Reclaiming marks the claim (`reclaimedAt`) rather than dropping it, and
 * touches no container or volume: the checkout keeps its project name and its
 * database, and its next start allocates a new block.
 */
export async function allocateReclaiming<T>(
	allocate: () => T,
	signal?: AbortSignal,
): Promise<T> {
	for (let reclaims = 0; ; reclaims++) {
		try {
			return allocate();
		} catch (error) {
			if (!(error instanceof PortBlockExhaustedError)) throw error;
			const states = await readClaimStates(error.claims).catch(() => undefined);
			if (!states)
				throw new PortBlockExhaustedError(error, { reclaim: "unreadable" });
			if (reclaims >= MAX_PORT_RECLAIMS)
				throw new PortBlockExhaustedError(error, {
					reclaim: "taken-meanwhile",
					states,
				});
			await reclaimPortBlock(error, states);
			signal?.throwIfAborted();
		}
	}
}

async function reclaimPortBlock(
	error: PortBlockExhaustedError,
	states: Record<string, ClaimState>,
): Promise<void> {
	const now = Date.now();
	const choice = chooseReclaim(error.blocked, error.claims, states, now);
	if (!choice)
		throw new PortBlockExhaustedError(error, { reclaim: "none-idle", states });

	// A claim a run used since the scan read it keeps its block; the next
	// attempt reads the claims afresh, and that run's claim is too recent to
	// choose again.
	const marked = await markOffsetClaimsReclaimed(
		pick(error.claims, choice.keys),
		new Date(now).toISOString(),
	);
	for (const key of marked) {
		const claim = error.claims[key];
		console.warn(
			formatWarn(
				`Every port block was claimed: reclaimed offset ${claim.offset} from ${offsetClaimHolder(key, claim)} (idle, last used ${formatClaimAge(key, claim, now)} ago). That checkout gets new ports on its next start; its containers, volumes and project name are untouched.`,
			),
		);
	}
}
