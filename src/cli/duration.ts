const DURATION_UNIT_MS: Record<string, number> = {
	d: 86_400_000,
	h: 3_600_000,
	m: 60_000,
};

/**
 * `7d`, `12h`, `30m`, or a bare number of days: in milliseconds, and as the
 * messages spell it. Undefined for anything else, zero included.
 */
export function parseIdleDuration(
	value: string,
): { ms: number; label: string } | undefined {
	const match = /^(\d+(?:\.\d+)?)(d|h|m)?$/.exec(value.trim());
	if (!match) return undefined;

	const unit = match[2] ?? "d";
	const ms = Number(match[1]) * DURATION_UNIT_MS[unit];

	return ms > 0 ? { ms, label: `${match[1]}${unit}` } : undefined;
}
