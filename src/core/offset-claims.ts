import { existsSync, realpathSync } from "node:fs";
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
 * A claim lives as long as its checkout directory: allocation ignores one
 * whose directory is gone, which is the only signal that separates "not
 * running" from "no longer exists". The sweep drops it, after removing the
 * checkout's volumes where the machine opted in, so it is also the record of
 * which project a deleted checkout used.
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
	updatedAt: string;
	/** Set on a suffixed claim, whose key is not the bare root. */
	root?: string;
	suffix?: string;
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

/** Every claim whose checkout still exists, by {@link offsetClaimKey}. */
export function readOffsetClaims(): Record<string, OffsetClaim> {
	return Object.fromEntries(
		Object.entries(readAllOffsetClaims()).filter(([key, claim]) =>
			existsSync(offsetClaimRoot(key, claim)),
		),
	);
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
			if (claim && !existsSync(offsetClaimRoot(key, claim))) delete claims[key];
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
 * Drop the claims under `keys`, whatever their checkouts' state: what
 * `buncargo ports release` does after checking no run holds them. A stale
 * claim otherwise holds its project name until its checkout runs again or is
 * deleted. The checkout's next run claims again.
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
 * Why the block at `offset` with `ports` is someone else's, or undefined when
 * it is free: another checkout, or another environment of this one, claims the
 * offset or one of the ports. `key` is the asker's own {@link offsetClaimKey}.
 */
export function offsetClaimConflict(
	claims: Record<string, OffsetClaim>,
	block: { offset: number; ports: readonly number[] },
	key: string,
): string | undefined {
	for (const [other, claim] of Object.entries(claims)) {
		if (other === key) continue;
		const holder = offsetClaimHolder(other, claim);
		if (claim.offset === block.offset)
			return `offset ${block.offset} is claimed by ${holder}`;
		const [shared] = sharedPorts(block, claim);
		if (shared !== undefined)
			return `port ${shared} is in the block ${holder} claims (offset ${claim.offset})`;
	}
	return undefined;
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
	if (
		current?.offset === offset &&
		current.projectName === projectName &&
		current.ports?.join() === ports.join()
	)
		return;
	claims[key] = {
		offset,
		ports,
		projectName,
		updatedAt: new Date().toISOString(),
		...(suffix ? { root, suffix } : {}),
	};
	writeJsonDocumentSync(getOffsetClaimsPath(), { version: VERSION, claims });
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
	return entries.flatMap(([key, claim], index) =>
		entries.slice(index + 1).flatMap(([otherKey, other]) => {
			const ports = sharedPorts(claim, other);
			if (claim.offset !== other.offset && ports.length === 0) return [];
			return [
				{
					holders: [
						offsetClaimHolder(key, claim),
						offsetClaimHolder(otherKey, other),
					],
					offsets: [claim.offset, other.offset],
					ports,
				} satisfies OffsetClaimOverlap,
			];
		}),
	);
}

/** One overlap as a sentence, naming both checkouts and what they share. */
export function describeOffsetClaimOverlap(
	overlap: OffsetClaimOverlap,
): string {
	const [a, b] = overlap.holders;
	const shared = `port${overlap.ports.length === 1 ? "" : "s"} ${overlap.ports.join(", ")}`;
	if (overlap.offsets[0] === overlap.offsets[1])
		return `${a} and ${b} both claim offset ${overlap.offsets[0]}${overlap.ports.length > 0 ? ` (${shared})` : ""}`;
	return `${a} (offset ${overlap.offsets[0]}) and ${b} (offset ${overlap.offsets[1]}) both claim ${shared}`;
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
