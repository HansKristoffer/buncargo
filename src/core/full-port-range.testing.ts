import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getOffsetClaimsPath, type OffsetClaim } from "./offset-claims";
import { writeJsonDocumentSync } from "./registry-file";

/**
 * A config whose one port is high enough that its range is exactly the hashed
 * 90 blocks (100 to 9000), which three claims can fill.
 */
export const FULL_RANGE_BASE_PORT = 30000;

/**
 * Fill every block from 100 to 9000 with the claims of three existing
 * checkouts under `dir`, each holding thirty blocks through its ports, last
 * used `usedDaysAgo[i]` days ago. Written straight to `offsets.json` under
 * the current `HOME`, so each claim carries the age a test gives it.
 */
export function fillPortRange(
	dir: string,
	usedDaysAgo: readonly [number, number, number],
): { roots: string[]; claims: Record<string, OffsetClaim> } {
	const now = Date.now();
	const roots = usedDaysAgo.map((_, index) => join(dir, `holder-${index}`));
	const claims = Object.fromEntries(
		usedDaysAgo.map((days, index) => {
			const root = join(dir, `holder-${index}`);
			mkdirSync(root, { recursive: true });
			const first = index * 30 + 1;
			const offsets = Array.from(
				{ length: 30 },
				(_, step) => (first + step) * 100,
			);
			const usedAt = new Date(now - days * 86_400_000).toISOString();
			const claim: OffsetClaim = {
				offset: first * 100,
				ports: offsets.map((offset) => FULL_RANGE_BASE_PORT + offset),
				projectName: `holder-${index}`,
				updatedAt: usedAt,
				usedAt,
			};
			return [root, claim];
		}),
	);
	writeJsonDocumentSync(getOffsetClaimsPath(), { version: 1, claims });
	return { roots, claims };
}
