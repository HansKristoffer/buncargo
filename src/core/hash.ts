/**
 * Stable, non-cryptographic 32-bit string hash (djb2-style).
 *
 * Used to derive deterministic per-project values such as port offsets and
 * watchdog file names, so the same repo path always maps to the same bucket
 * across runs and processes. Not suitable for security purposes.
 */
export function simpleHash(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash;
	}
	return Math.abs(hash);
}
