import { pick } from "hanzio";
import { readClaimStates } from "../container-runtime";
import {
	offsetClaimHolder,
	releaseOffsetClaimsIfUnchanged,
} from "../core/offset-claims";
import {
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
 * Run a claiming allocation; when the range is full, reclaim an idle
 * checkout's block and run it again. What `prepareStartAsync` allocates
 * through, so `dev`, `start()`, `ci` and the prisma path all reclaim.
 */
export async function allocateReclaiming<T>(
	allocate: () => T,
	signal?: AbortSignal,
): Promise<T> {
	for (let reclaims = 0; ; reclaims++) {
		try {
			return allocate();
		} catch (error) {
			const reclaimable =
				error instanceof PortBlockExhaustedError &&
				reclaims < MAX_PORT_RECLAIMS;
			if (!reclaimable) throw error;
			await reclaimPortBlock(error);
			signal?.throwIfAborted();
		}
	}
}

/**
 * A full range on a claiming start: drop the claims of the least recently
 * used block whose checkouts have no run and no containers, and say whose.
 * The caller allocates again. Throws the exhaustion again, now with every
 * holder's state, when no claim is idle or the states cannot be read.
 *
 * Never touches a container or a volume: the checkout keeps its data, and its
 * next start allocates a new block.
 */
async function reclaimPortBlock(error: PortBlockExhaustedError): Promise<void> {
	const states = await readClaimStates(error.claims).catch(() => undefined);
	if (!states) throw error;
	const choice = chooseReclaim(error.blocked, error.claims, states);
	if (!choice) throw new PortBlockExhaustedError(error, states);

	const released = await releaseOffsetClaimsIfUnchanged(
		pick(error.claims, choice.keys),
	);
	// A claim that changed since the scan read it is back in use; the next
	// attempt reads the claims afresh.
	const now = Date.now();
	for (const key of released) {
		const claim = error.claims[key];
		console.warn(
			formatWarn(
				`Every port block was claimed: reclaimed offset ${claim.offset} from ${offsetClaimHolder(key, claim)} (idle, last used ${formatClaimAge(claim, now)} ago). That checkout gets new ports on its next start; its containers and volumes are untouched.`,
			),
		);
	}
}
