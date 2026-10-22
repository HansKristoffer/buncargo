import { isRecord, safeJsonParse, toArray } from "hanzio";
import type { BuncargoVolume } from "../types";
import { type AppleContainerCli, runAppleAsync } from "./cli";

/**
 * Apple `container` volumes, for `buncargo prune`.
 *
 * Apple records no Compose project on a volume, and its names are
 * `<project>-<volume>` with project names that themselves contain dashes, so
 * a name cannot be split back into the two reliably. These therefore arrive
 * with no `project`, and prune reports them as unattributable rather than
 * guessing which checkout they belong to.
 *
 * Its `volume ls` output shape has moved between releases like the rest of
 * this CLI, so both the JSON and the plain-table forms are accepted.
 */
export function parseAppleVolumeNames(stdout: string): string[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	const parsed = safeJsonParse(trimmed);
	if (parsed.ok) {
		const names = toArray(parsed.data).flatMap((entry) => {
			if (typeof entry === "string") return [entry];
			if (!isRecord(entry)) return [];
			const name = entry.name ?? entry.Name ?? entry.id;
			return typeof name === "string" && name ? [name] : [];
		});
		if (names.length > 0) return names;
	}
	// Not JSON, or JSON with no names: fall through to the table form.
	return trimmed
		.split("\n")
		.slice(1) // a header row
		.map((line) => line.trim().split(/\s+/)[0] ?? "")
		.filter(Boolean);
}

export async function listAppleVolumes(
	cli: AppleContainerCli,
): Promise<BuncargoVolume[]> {
	const result = await runAppleAsync(cli, ["volume", "ls", "--format", "json"]);
	if (!result.ok) return [];
	return parseAppleVolumeNames(result.stdout).map((name) => ({
		name,
		runtime: "apple" as const,
	}));
}

export async function removeAppleVolumes(
	cli: AppleContainerCli,
	names: string[],
): Promise<{ name: string; error: string }[]> {
	const failures: { name: string; error: string }[] = [];
	for (const name of names) {
		const result = await runAppleAsync(cli, ["volume", "delete", name]);
		if (!result.ok)
			failures.push({
				name,
				error: result.stderr.trim() || `container volume delete ${name} failed`,
			});
	}
	return failures;
}
