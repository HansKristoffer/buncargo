import { realpathSync } from "node:fs";
import { checkoutDeleted } from "./checkout-presence";
import { withFileLock, withFileLockSync } from "./file-lock";
import { readJsonDocumentSync, writeJsonDocumentSync } from "./registry-file";
import { stateFilePath } from "./state-paths";

/**
 * Which checkout owns which port offset, machine-wide (`~/.buncargo/offsets.json`).
 *
 * Offsets are a hash of the project and worktree into 90 slots, and a machine
 * with 25 worktrees of one project has collisions by arithmetic. The allocator
 * only saw a collision while the other checkout was running, so which checkout
 * got which ports depended on which started first, and URLs moved between
 * days. A claim makes the first assignment stick: the allocator skips an
 * offset another checkout holds, running or not.
 *
 * A developer's dev claim lives as long as its checkout directory: allocation
 * ignores one whose directory is gone, which is the only signal that separates
 * "not running" from "no longer exists". When every block is claimed, a
 * claiming start reclaims the block of the checkout started least recently
 * that has no run and no containers ({@link offsetClaimLastUsed}). The sweep drops a deleted checkout's
 * claim after removing its volumes where the machine opted in, so the claim is
 * also the record of which project a deleted checkout used.
 *
 * A throwaway environment's claim (suffixed, or any in CI) is released when its
 * stack is torn down: CI runners keep their directories between jobs, and their
 * claims filled every block of the machine.
 *
 * A suffixed environment (`withSuffix`, `buncargo ci`, an E2E stack) hashes to
 * its own offset and claims it under its own key, so it never replaces its
 * checkout's dev claim. Parallel suffixed runs that hash alike probed together,
 * before any of them had bound a port, and all took the same block.
 *
 * A claim's project name is the other half: no two existing checkouts may
 * claim one name (see {@link projectNameClaimant}).
 */

const VERSION = 1;

export interface OffsetClaim {
	offset: number;
	/**
	 * The block's ports when it was claimed, sorted. Two configs collide on a
	 * port without sharing an offset: api 3000 at offset 1100 and admin 4000 at
	 * offset 100 are both 4100. A claim written before this was recorded holds
	 * its offset alone.
	 */
	ports?: number[];
	projectName: string;
	/** When the claim last changed: its offset, ports or project name. */
	updatedAt: string;
	/**
	 * When a claiming run last started on the block. What "least recently
	 * used" means when a full range reclaims an idle claim, and what
	 * `ports release --idle` measures. A claim written before this was
	 * recorded was last used at its `updatedAt`.
	 */
	usedAt?: string;
	/**
	 * When a full range or `ports release --idle` gave this claim's block to
	 * other checkouts. The claim stays, holding no block: it still keeps the
	 * checkout's project name to itself and its volumes known to `prune` and
	 * the sweep. The checkout's next claiming run claims a block again.
	 */
	reclaimedAt?: string;
	/** Set on a suffixed claim, whose key is not the bare root. */
	root?: string;
	suffix?: string;
	/**
	 * When a sweep first found the checkout deleted. Its volumes wait for a
	 * later pass to find it still gone (see `settleDeletedCheckouts`).
	 */
	deletedSeenAt?: string;
}

/**
 * Where a checkout's claim is stored. Never parsed: a suffixed claim carries its
 * `root` and `suffix`, and a dev claim's key is its root.
 */
export function offsetClaimKey(root: string, suffix?: string): string {
	return suffix ? `${root}#${suffix}` : root;
}

/** The checkout a claim belongs to. */
export function offsetClaimRoot(key: string, claim: OffsetClaim): string {
	return claim.root ?? key;
}

/** How a claim's holder reads in messages: its checkout, and its suffix if any. */
export function offsetClaimHolder(key: string, claim: OffsetClaim): string {
	const root = offsetClaimRoot(key, claim);
	return claim.suffix ? `${root} (${claim.suffix})` : root;
}

interface OffsetClaimsDocument {
	version: number;
	claims: Record<string, OffsetClaim>;
}

export function getOffsetClaimsPath(): string {
	return stateFilePath("offsets.json");
}

function validate(value: unknown): OffsetClaimsDocument | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const document = value as Partial<OffsetClaimsDocument>;
	if (document.version !== VERSION) return undefined;
	if (typeof document.claims !== "object" || document.claims === null)
		return undefined;
	const claims = Object.fromEntries(
		Object.entries(document.claims).flatMap(([key, claim]) => {
			const valid = validateClaim(claim);
			return valid ? [[key, valid]] : [];
		}),
	);
	return { version: VERSION, claims };
}

function validateClaim(value: unknown): OffsetClaim | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { ports, ...claim } = value as Partial<OffsetClaim>;
	if (!Number.isInteger(claim.offset) || typeof claim.projectName !== "string")
		return undefined;
	const valid = claim as OffsetClaim;
	// Ports this version cannot read leave the claim holding its offset alone.
	return Array.isArray(ports) && ports.every((port) => Number.isInteger(port))
		? { ...valid, ports }
		: valid;
}

/** Every claim, including those of deleted checkouts the sweep has not settled. */
export function readAllOffsetClaims(): Record<string, OffsetClaim> {
	return readJsonDocumentSync(getOffsetClaimsPath(), validate)?.claims ?? {};
}

/**
 * Every claim whose checkout still exists, by {@link offsetClaimKey}. One this
 * user cannot read counts as existing.
 */
export function readOffsetClaims(): Record<string, OffsetClaim> {
	return Object.fromEntries(
		Object.entries(readAllOffsetClaims()).filter(
			([key, claim]) => !checkoutDeleted(offsetClaimRoot(key, claim)),
		),
	);
}

/**
 * Stamp `at` on the claims under `seen` whose checkouts are still gone and
 * carry no stamp yet, and clear the stamp of those under `back`, whose
 * checkouts are there again.
 */
export async function markDeletedOffsetClaims(input: {
	seen: readonly string[];
	back: readonly string[];
	at: string;
}): Promise<void> {
	if (input.seen.length === 0 && input.back.length === 0) return;
	await withFileLock(getOffsetClaimsPath(), async () => {
		const claims = readAllOffsetClaims();
		for (const key of input.seen) {
			const claim = claims[key];
			if (
				claim &&
				claim.deletedSeenAt === undefined &&
				checkoutDeleted(offsetClaimRoot(key, claim))
			)
				claim.deletedSeenAt = input.at;
		}
		for (const key of input.back) {
			const claim = claims[key];
			if (claim && !checkoutDeleted(offsetClaimRoot(key, claim)))
				delete claim.deletedSeenAt;
		}
		writeJsonDocumentSync(getOffsetClaimsPath(), { version: VERSION, claims });
	});
}

/** Drop the claims under `keys` whose checkouts are still gone. */
export async function dropDeletedOffsetClaims(
	keys: readonly string[],
): Promise<void> {
	if (keys.length === 0) return;
	await withFileLock(getOffsetClaimsPath(), async () => {
		const claims = readAllOffsetClaims();
		for (const key of keys) {
			const claim = claims[key];
			if (claim && checkoutDeleted(offsetClaimRoot(key, claim)))
				delete claims[key];
		}
		writeJsonDocumentSync(getOffsetClaimsPath(), { version: VERSION, claims });
	});
}

/** Every claim of the checkout at `root`, its dev claim and its suffixed ones, by key. */
export function offsetClaimsOf(root: string): Record<string, OffsetClaim> {
	return Object.fromEntries(
		Object.entries(readAllOffsetClaims()).filter(([key, claim]) =>
			sameCheckout(offsetClaimRoot(key, claim), root),
		),
	);
}

/**
 * Drop the claims under `keys`, whatever they say now. A release decided from
 * an earlier read (no run on record, a confirmation) is
 * {@link releaseOffsetClaimsIfUnchanged}, or a run that allocated in between
 * loses the claim it just wrote.
 */
export async function releaseOffsetClaims(
	keys: readonly string[],
): Promise<void> {
	if (keys.length === 0) return;
	await withFileLock(getOffsetClaimsPath(), async () => {
		const claims = readAllOffsetClaims();
		for (const key of keys) delete claims[key];
		writeJsonDocumentSync(getOffsetClaimsPath(), { version: VERSION, claims });
	});
}

/**
 * Whether a claim is still the one that was read: no run has rewritten or
 * used it since. Compared by what a run changes, not whole: a reader may have
 * filled in a port-less claim's ports from its lockfile.
 */
function unchangedSince(
	current: OffsetClaim | undefined,
	read: OffsetClaim,
): current is OffsetClaim {
	return (
		current !== undefined &&
		current.offset === read.offset &&
		current.projectName === read.projectName &&
		current.updatedAt === read.updatedAt &&
		current.usedAt === read.usedAt
	);
}

/**
 * Drop each claim of `expected` that no run has claimed or used since it was
 * read, under the claims lock. What every release that decides from an
 * earlier read uses: a run that allocates in between rewrites the claim's
 * `usedAt` (`claimOffset`), and so keeps it. Returns the keys it dropped.
 */
export async function releaseOffsetClaimsIfUnchanged(
	expected: Record<string, OffsetClaim>,
): Promise<string[]> {
	const keys = Object.keys(expected);
	if (keys.length === 0) return [];
	return withFileLock(getOffsetClaimsPath(), async () => {
		const claims = readAllOffsetClaims();
		const released = keys.filter((key) =>
			unchangedSince(claims[key], expected[key]),
		);
		for (const key of released) delete claims[key];
		if (released.length > 0)
			writeJsonDocumentSync(getOffsetClaimsPath(), {
				version: VERSION,
				claims,
			});
		return released;
	});
}

/**
 * The suffixed claims of the stack `projectName` at `root`, as `claims` holds
 * them, that its run on record used: a claim used after `owner` started was
 * allocated by a later job, which has not published its run yet.
 */
function suffixedClaimsOf(
	claims: Record<string, OffsetClaim>,
	stack: { projectName: string; root: string },
	owner: { startedAt: string } | null,
): Record<string, OffsetClaim> {
	return Object.fromEntries(
		Object.entries(claims).filter(
			([key, claim]) =>
				claim.suffix !== undefined &&
				claim.projectName === stack.projectName &&
				offsetClaimRoot(key, claim) === stack.root &&
				(owner === null || offsetClaimLastUsed(claim) <= owner.startedAt),
		),
	);
}

/**
 * Drop the suffixed claims of a stack whose containers are gone: a throwaway
 * environment (`ci`, an E2E stack) torn down by the sweep or `buncargo stop`
 * rather than by its own `stop()`. A CI runner's directory never goes, so
 * nothing else would free the block. A deleted checkout's claims stay: they
 * are the sweep's record of its volumes.
 *
 * `read` is the claims as they were before the teardown was decided (see
 * {@link suffixedClaimsOf}); a claim a new job of the same directory wrote or
 * used since is its block, and stays.
 */
export async function releaseSuffixedClaimsOf(
	stack: { projectName: string; root: string },
	read: Record<string, OffsetClaim>,
	owner: { startedAt: string } | null,
): Promise<void> {
	if (checkoutDeleted(stack.root)) return;
	await releaseOffsetClaimsIfUnchanged(suffixedClaimsOf(read, stack, owner));
}

/**
 * Why the block at `offset` with `ports` is someone else's, or undefined when
 * it is free: another checkout, or another environment of this one, claims the
 * offset or one of the ports. `key` is the asker's own {@link offsetClaimKey}.
 */
export function offsetClaimConflict(
	claims: Record<string, OffsetClaim>,
	block: { offset: number; ports: readonly number[] },
	key: string,
): string | undefined {
	return offsetClaimConflicts(claims, block, key)[0]?.reason;
}

/**
 * Every claim that keeps `key` off the block, by its key, with the reason
 * {@link offsetClaimConflict} gives for it. A full range reclaims a block only
 * when every claim on it can go.
 */
export function offsetClaimConflicts(
	claims: Record<string, OffsetClaim>,
	block: { offset: number; ports: readonly number[] },
	key: string,
): { key: string; reason: string }[] {
	return Object.entries(claims).flatMap(([other, claim]) => {
		if (other === key) return [];
		const holder = offsetClaimHolder(other, claim);
		if (claim.offset === block.offset)
			return [
				{
					key: other,
					reason: `offset ${block.offset} is claimed by ${holder}`,
				},
			];
		const [shared] = sharedPorts(block, claim);
		return shared === undefined
			? []
			: [
					{
						key: other,
						reason: `port ${shared} is in the block ${holder} claims (offset ${claim.offset})`,
					},
				];
	});
}

/**
 * Another existing checkout's claim on `projectName` (who holds it, and its
 * checkout), or undefined when no other checkout uses it.
 *
 * The project name decides which containers and volumes a run uses, so two
 * checkouts under one name share a database, and one's `ci` teardown
 * deletes the other's. Their offsets keep them apart only on ports. Claims of
 * this checkout under another spelling of its path are its own.
 */
export function projectNameClaimant(
	claims: Record<string, OffsetClaim>,
	input: { root: string; projectName: string },
): { holder: string; root: string } | undefined {
	for (const [key, claim] of Object.entries(claims)) {
		if (claim.projectName !== input.projectName) continue;
		const root = offsetClaimRoot(key, claim);
		if (!sameCheckout(root, input.root))
			return { holder: offsetClaimHolder(key, claim), root };
	}
	return undefined;
}

function sameCheckout(a: string, b: string): boolean {
	if (a === b) return true;
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

/**
 * Record that `root` uses the block at `offset`, made of `ports`.
 *
 * Read-modify-write: call it under {@link withOffsetClaimsLock}, together with
 * the read that chose the offset, or two checkouts starting at once can both
 * take it.
 */
export function claimOffset(input: {
	root: string;
	offset: number;
	ports: readonly number[];
	projectName: string;
	suffix?: string;
}): void {
	const { root, offset, projectName, suffix } = input;
	const ports = [...new Set(input.ports)].sort((a, b) => a - b);
	const key = offsetClaimKey(root, suffix);
	const claims = readAllOffsetClaims();
	const current = claims[key];
	const now = new Date().toISOString();
	const unchanged =
		current?.offset === offset &&
		current.projectName === projectName &&
		current.ports?.join() === ports.join() &&
		current.reclaimedAt === undefined;
	// Written on every claiming run, even when nothing else changed: a reclaim
	// that read this claim as idle compares it before marking it
	// (`markOffsetClaimsReclaimed`), so a run that started in between keeps
	// its block. One file write, under the lock the caller already holds.
	claims[key] = unchanged
		? { ...current, usedAt: now }
		: {
				offset,
				ports,
				projectName,
				updatedAt: now,
				usedAt: now,
				...(suffix ? { root, suffix } : {}),
			};
	writeJsonDocumentSync(getOffsetClaimsPath(), { version: VERSION, claims });
}

/** When a claim's block was last started on. */
export function offsetClaimLastUsed(claim: OffsetClaim): string {
	return claim.usedAt ?? claim.updatedAt;
}

/** Whether a claim holds its block: every claim does until it is reclaimed. */
export function offsetClaimHoldsBlock(claim: OffsetClaim): boolean {
	return claim.reclaimedAt === undefined;
}

/**
 * Mark each claim of `expected` reclaimed if no run has used it since it was
 * read, and its checkout still exists. A claim a run refreshed or rewrote in
 * the meantime keeps its block, and a deleted checkout's is the sweep's. The
 * claim itself stays (see {@link OffsetClaim.reclaimedAt}). Returns the keys
 * it marked.
 */
export async function markOffsetClaimsReclaimed(
	expected: Record<string, OffsetClaim>,
	at: string,
): Promise<string[]> {
	const keys = Object.keys(expected);
	if (keys.length === 0) return [];
	return withFileLock(getOffsetClaimsPath(), async () => {
		const claims = readAllOffsetClaims();
		const marked = keys.filter((key) => {
			const current = claims[key];
			return (
				unchangedSince(current, expected[key]) &&
				offsetClaimHoldsBlock(current) &&
				!checkoutDeleted(offsetClaimRoot(key, current))
			);
		});
		for (const key of marked) claims[key].reclaimedAt = at;
		if (marked.length > 0)
			writeJsonDocumentSync(getOffsetClaimsPath(), {
				version: VERSION,
				claims,
			});
		return marked;
	});
}

/** Hold the machine-wide claims file across choosing an offset and claiming it. */
export function withOffsetClaimsLock<T>(operation: () => T): T {
	return withFileLockSync(getOffsetClaimsPath(), operation);
}

/** Two claims whose blocks collide, and the ports they share (none known when only their offsets are equal). */
export interface OffsetClaimOverlap {
	holders: [string, string];
	offsets: [number, number];
	ports: number[];
}

/**
 * Pairs of claims that collide by the rule {@link offsetClaimConflict}
 * allocates by: the same offset, or a shared port. A pre-lock race, a copied
 * lockfile or two configs whose ports meet through different offsets.
 */
export function overlappingOffsetClaims(
	claims: Record<string, OffsetClaim>,
): OffsetClaimOverlap[] {
	const entries = Object.entries(claims);
	const overlaps: OffsetClaimOverlap[] = [];
	for (const [index, [key, claim]] of entries.entries()) {
		for (const [otherKey, other] of entries.slice(index + 1)) {
			const ports = sharedPorts(claim, other);
			if (claim.offset !== other.offset && ports.length === 0) continue;
			overlaps.push({
				holders: [
					offsetClaimHolder(key, claim),
					offsetClaimHolder(otherKey, other),
				],
				offsets: [claim.offset, other.offset],
				ports,
			});
		}
	}
	return overlaps;
}

/** One overlap as a sentence, naming both checkouts and what they share. */
export function describeOffsetClaimOverlap(
	overlap: OffsetClaimOverlap,
): string {
	const [a, b] = overlap.holders;
	const [offset, otherOffset] = overlap.offsets;
	const noun = overlap.ports.length === 1 ? "port" : "ports";
	const shared = `${noun} ${overlap.ports.join(", ")}`;
	if (offset !== otherOffset)
		return `${a} (offset ${offset}) and ${b} (offset ${otherOffset}) both claim ${shared}`;

	const detail = overlap.ports.length > 0 ? ` (${shared})` : "";
	return `${a} and ${b} both claim offset ${offset}${detail}`;
}

function sharedPorts(
	a: { ports?: readonly number[] },
	b: { ports?: readonly number[] },
): number[] {
	return (a.ports ?? []).filter((port) => b.ports?.includes(port));
}

/** Project names claimed by more than one existing checkout, with their holders. */
export function sharedProjectNameClaims(
	claims: Record<string, OffsetClaim>,
): Map<string, string[]> {
	const byName = new Map<string, { roots: string[]; holders: string[] }>();
	for (const [key, claim] of Object.entries(claims)) {
		const entry = byName.get(claim.projectName) ?? { roots: [], holders: [] };
		const root = offsetClaimRoot(key, claim);
		if (entry.roots.some((other) => sameCheckout(other, root))) continue;
		entry.roots.push(root);
		entry.holders.push(offsetClaimHolder(key, claim));
		byName.set(claim.projectName, entry);
	}
	return new Map(
		[...byName]
			.filter(([, entry]) => entry.holders.length > 1)
			.map(([name, entry]) => [name, entry.holders]),
	);
}
