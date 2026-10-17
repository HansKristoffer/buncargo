import { existsSync } from "node:fs";
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
 * checkout's dev claim. Parallel CI jobs on one machine are the case this is
 * for: each runner's checkout has the same directory name and so the same hash,
 * and without a claim they probed together, before any of them had bound a
 * port, and all took the same block.
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
		const shared = block.ports.find((port) => claim.ports?.includes(port));
		if (shared !== undefined)
			return `port ${shared} is in the block ${holder} claims (offset ${claim.offset})`;
	}
	return undefined;
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

/** Offsets more than one existing claim holds, e.g. a pre-lock race. */
export function duplicateOffsetClaims(
	claims: Record<string, OffsetClaim>,
): Map<number, string[]> {
	const byOffset = new Map<number, string[]>();
	for (const [key, claim] of Object.entries(claims))
		byOffset.set(claim.offset, [
			...(byOffset.get(claim.offset) ?? []),
			offsetClaimHolder(key, claim),
		]);
	return new Map([...byOffset].filter(([, roots]) => roots.length > 1));
}
