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
 */

const VERSION = 1;

export interface OffsetClaim {
	offset: number;
	projectName: string;
	updatedAt: string;
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
		Object.entries(document.claims).filter(
			([, claim]) =>
				Number.isInteger(claim?.offset) &&
				typeof claim?.projectName === "string",
		),
	);
	return { version: VERSION, claims };
}

/** Every claim, including those of deleted checkouts the sweep has not settled. */
export function readAllOffsetClaims(): Record<string, OffsetClaim> {
	return readJsonDocumentSync(getOffsetClaimsPath(), validate)?.claims ?? {};
}

/** Every claim whose checkout still exists, by root. */
export function readOffsetClaims(): Record<string, OffsetClaim> {
	return Object.fromEntries(
		Object.entries(readAllOffsetClaims()).filter(([root]) => existsSync(root)),
	);
}

/** Drop the claims of `roots` whose directories are still gone. */
export async function dropDeletedOffsetClaims(
	roots: readonly string[],
): Promise<void> {
	if (roots.length === 0) return;
	await withFileLock(getOffsetClaimsPath(), async () => {
		const claims = readAllOffsetClaims();
		for (const root of roots) if (!existsSync(root)) delete claims[root];
		writeJsonDocumentSync(getOffsetClaimsPath(), { version: VERSION, claims });
	});
}

/** The other checkout holding `offset`, if any. */
export function offsetClaimedBy(
	claims: Record<string, OffsetClaim>,
	offset: number,
	root: string,
): string | undefined {
	return Object.entries(claims).find(
		([other, claim]) => other !== root && claim.offset === offset,
	)?.[0];
}

/**
 * Record that `root` uses `offset`.
 *
 * Read-modify-write: call it under {@link withOffsetClaimsLock}, together with
 * the read that chose the offset, or two checkouts starting at once can both
 * take it.
 */
export function claimOffset(
	root: string,
	offset: number,
	projectName: string,
): void {
	const claims = readAllOffsetClaims();
	if (
		claims[root]?.offset === offset &&
		claims[root]?.projectName === projectName
	)
		return;
	claims[root] = { offset, projectName, updatedAt: new Date().toISOString() };
	writeJsonDocumentSync(getOffsetClaimsPath(), { version: VERSION, claims });
}

/** Hold the machine-wide claims file across choosing an offset and claiming it. */
export function withOffsetClaimsLock<T>(operation: () => T): T {
	return withFileLockSync(getOffsetClaimsPath(), operation);
}

/** Offsets more than one existing checkout claims, e.g. a pre-lock race. */
export function duplicateOffsetClaims(
	claims: Record<string, OffsetClaim>,
): Map<number, string[]> {
	const byOffset = new Map<number, string[]>();
	for (const [root, claim] of Object.entries(claims))
		byOffset.set(claim.offset, [...(byOffset.get(claim.offset) ?? []), root]);
	return new Map([...byOffset].filter(([, roots]) => roots.length > 1));
}
