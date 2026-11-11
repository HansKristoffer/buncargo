import { typedSwitch } from "hanzio";
import {
	type OffsetClaim,
	offsetClaimHolder,
	offsetClaimHoldsBlock,
	offsetClaimRoot,
	RECLAIM_MIN_IDLE_MS,
} from "./offset-claims";
import { lastCheckoutCommandAt } from "./run-activity";

/**
 * Whether a claim's checkout uses its block now: a live run (`running`), a
 * finished run's containers waiting out the idle hold or still standing
 * (`held`), or neither (`idle`). Only an idle claim may be reclaimed.
 */
export type ClaimState = "running" | "held" | "idle";

/**
 * What became of reclaiming when the error was thrown: not tried (the
 * synchronous path), nothing idle to reclaim, the states could not be read,
 * or the blocks it reclaimed were taken by other starts first.
 */
export type ReclaimOutcome =
	"not-tried" | "none-idle" | "unreadable" | "taken-meanwhile";

/** One offset a full scan could not use, and what is in the way. */
export interface BlockedOffset {
	offset: number;
	problem: string;
	/** The claims on the block, by key. Empty when no claim is in the way. */
	claimKeys: string[];
	/** A port of the block is above 65535 or held by a process: freeing its claims would not free it. */
	unusable: boolean;
}

/** Every block of the range is taken. What a full range reclaims from. */
export class PortBlockExhaustedError extends Error {
	readonly root: string;
	readonly range: { min: number; max: number; hashed: number };
	readonly blocked: BlockedOffset[];
	/** The claims the scan read, by key. */
	readonly claims: Record<string, OffsetClaim>;
	/** The first claim-free offset above the range whose ports stay valid, for `ports pin`. */
	readonly pinnable: number | undefined;

	constructor(
		input: Omit<PortBlockExhaustedError, keyof Error>,
		outcome: {
			reclaim: ReclaimOutcome;
			states?: Record<string, ClaimState>;
		} = { reclaim: "not-tried" },
		now = Date.now(),
	) {
		super(describePortExhaustion(input, outcome, now));
		this.name = "PortBlockExhaustedError";
		this.root = input.root;
		this.range = input.range;
		this.blocked = input.blocked;
		this.claims = input.claims;
		this.pinnable = input.pinnable;
	}
}

/**
 * Each claim's state, from what a reader found: the checkouts with a live run
 * or a finished run still on record with services, and the Compose projects
 * with a running container. A checkout's run keeps every claim of it, its
 * suffixed ones too, as `ports release --root` treats them.
 */
export function claimStates(
	claims: Record<string, OffsetClaim>,
	activity: {
		liveRoots: ReadonlySet<string>;
		heldRoots: ReadonlySet<string>;
		runningProjects: ReadonlySet<string>;
	},
): Record<string, ClaimState> {
	return Object.fromEntries(
		Object.entries(claims).map(([key, claim]): [string, ClaimState] => {
			const root = offsetClaimRoot(key, claim);
			if (activity.liveRoots.has(root)) return [key, "running"];
			const held =
				activity.heldRoots.has(root) ||
				activity.runningProjects.has(claim.projectName);
			return [key, held ? "held" : "idle"];
		}),
	);
}

/** Whether a claim may give its block up: idle, and not used in the last {@link RECLAIM_MIN_IDLE_MS}. */
function reclaimable(
	key: string,
	claim: OffsetClaim,
	state: ClaimState | undefined,
	now: number,
): boolean {
	return (
		state === "idle" && now - lastUsedMs(key, claim) >= RECLAIM_MIN_IDLE_MS
	);
}

/**
 * Which claims a full range reclaims, or undefined when none can go: those of
 * the block whose claims are all reclaimable and were used least recently,
 * judged by the most recent of them. Ties go to the scan order, so the choice
 * is the same on every machine with the same claims.
 */
export function chooseReclaim(
	blocked: readonly BlockedOffset[],
	claims: Record<string, OffsetClaim>,
	states: Record<string, ClaimState>,
	now: number,
): { offset: number; keys: string[] } | undefined {
	let best: { offset: number; keys: string[]; usedAt: number } | undefined;
	for (const block of blocked) {
		const freeable =
			!block.unusable &&
			block.claimKeys.length > 0 &&
			block.claimKeys.every((key) =>
				reclaimable(key, claims[key], states[key], now),
			);
		if (!freeable) continue;
		const usedAt = Math.max(
			...block.claimKeys.map((key) => lastUsedMs(key, claims[key])),
		);
		if (!best || usedAt < best.usedAt)
			best = { offset: block.offset, keys: block.claimKeys, usedAt };
	}
	return best && { offset: best.offset, keys: best.keys };
}

/**
 * The claims holding a block that are reclaimable and were last used longer
 * than `idleMs` ago, for `ports release --idle`.
 */
export function idleClaims(
	claims: Record<string, OffsetClaim>,
	states: Record<string, ClaimState>,
	idleMs: number,
	now: number,
): Record<string, OffsetClaim> {
	return Object.fromEntries(
		Object.entries(claims).filter(
			([key, claim]) =>
				offsetClaimHoldsBlock(claim) &&
				reclaimable(key, claim, states[key], now) &&
				now - lastUsedMs(key, claim) > idleMs,
		),
	);
}

/**
 * When a claim's checkout was last used: a run claiming its block, or a
 * buncargo command in it. A run that started long ago and was released a
 * minute ago is in use; its start alone made it the first to go. No readable
 * time counts as never used.
 */
function lastUsedMs(key: string, claim: OffsetClaim): number {
	const claimed = Date.parse(claim.usedAt);
	return Math.max(
		Number.isNaN(claimed) ? 0 : claimed,
		lastCheckoutCommandAt(offsetClaimRoot(key, claim)) ?? 0,
	);
}

/** `3d`, `5h`, `12m`: how long ago a claim's checkout was last used. */
export function formatClaimAge(
	key: string,
	claim: OffsetClaim,
	now: number,
): string {
	const time = lastUsedMs(key, claim);
	if (time === 0) return "unknown";
	const minutes = Math.max(0, Math.round((now - time) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export const CLAIM_STATE_LABELS: Record<ClaimState, string> = {
	running: "running",
	held: "containers held",
	idle: "idle",
};

/**
 * The exhaustion message: every holder in the way with its age and, once a
 * reader has found them, its state, then the commands that free a block.
 */
export function describePortExhaustion(
	input: Omit<PortBlockExhaustedError, keyof Error>,
	outcome: {
		reclaim: ReclaimOutcome;
		states?: Record<string, ClaimState>;
	},
	now: number,
): string {
	const { root, range, blocked, claims } = input;
	const { states } = outcome;
	const keys = [...new Set(blocked.flatMap((block) => block.claimKeys))].sort(
		(a, b) => lastUsedMs(a, claims[a]) - lastUsedMs(b, claims[b]),
	);
	const holderLines = keys.map((key) => {
		const claim = claims[key];
		const state = states?.[key];
		const label = state ? `${CLAIM_STATE_LABELS[state]}, ` : "";
		const offset = String(claim.offset).padStart(5);
		return `  ${offset}  ${offsetClaimHolder(key, claim)} (${label}last used ${formatClaimAge(key, claim, now)} ago)`;
	});
	const others = blocked.filter((block) => block.claimKeys.length === 0);
	const [firstOther] = others;
	const other = holderLines.length > 0 ? "other " : "";
	const otherCount =
		others.length === 1
			? `1 ${other}block is`
			: `${others.length} ${other}blocks are`;
	const otherLine = firstOther
		? [
				`${otherCount} taken by processes or out of range, e.g. at ${firstOther.offset}: ${firstOther.problem}.`,
			]
		: [];
	const reclaimed = typedSwitch(outcome.reclaim, {
		"not-tried": () => "",
		"none-idle": () =>
			" No block could be reclaimed: every claim on one is running, holds containers or was used in the last hour, or a process holds one of its ports.",
		unreadable: () =>
			" Which holders are idle could not be read (the run registry or a container runtime did not answer), so no block was reclaimed.",
		"taken-meanwhile": () =>
			" The idle blocks reclaimed for it were taken by other starts first.",
	});
	const selfReclaim =
		outcome.reclaim === "not-tried"
			? " `buncargo dev` and `prepareStartAsync()` reclaim an idle checkout's block by themselves."
			: "";
	const pin =
		input.pinnable === undefined
			? []
			: [
					`Or move this checkout above the range: \`buncargo ports pin ${input.pinnable}\`.`,
				];
	return [
		`Could not allocate a free port block for ${root}: every offset from ${range.min} to ${range.max} (starting at ${range.hashed}) is taken.${reclaimed}`,
		...(holderLines.length > 0
			? ["Claims in the way, least recently used first:", ...holderLines]
			: []),
		...otherLine,
		"Free one: stop a checkout you no longer need (`buncargo stop --all --root <path>`) and drop its claims (`buncargo ports release --root <path>`), or free the blocks of checkouts idle for a week (`buncargo ports release --idle=7d`)." +
			selfReclaim,
		...pin,
	].join("\n");
}

/**
 * Why a checkout with no block yet has no ports of its own, and the way out.
 * The ports a read reports for it are where the hash puts it, in a block
 * another checkout claims.
 */
export function unallocatedPortsMessage(root: string): string {
	return `${root} has no port block yet: every block in the range is claimed by another checkout, so the ports shown for it are not its own. \`buncargo dev\` allocates one, reclaiming an idle checkout's block if it has to; or pin one now with \`buncargo ports pin <offset>\` (\`buncargo ports\` lists the claims).`;
}
