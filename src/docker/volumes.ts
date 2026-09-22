import type { BuncargoVolume } from "../types";
import { runDockerAsync } from "./binary";

/**
 * Reading and removing Docker volumes, for `buncargo prune`.
 *
 * Attribution comes from Compose's own `com.docker.compose.project` label,
 * which Compose writes when it creates the volume. Buncargo adds no labels of
 * its own: changing a volume's definition makes Compose prompt to recreate it,
 * and recreating a volume is exactly the data loss prune exists to avoid.
 */

const LIST_ARGS = [
	"volume",
	"ls",
	"--format",
	'{{.Name}}\t{{.Label "com.docker.compose.project"}}',
];

/**
 * Docker's own name for a volume nobody named: 64 hex characters.
 *
 * These are anonymous volumes, created for a container's unnamed mount and
 * removed with it. A compose file's named volume never looks like this, so
 * they are not buncargo's to reason about — and on a working machine there
 * are hundreds, which would bury the handful that matter.
 */
function isAnonymousVolume(name: string): boolean {
	return /^[0-9a-f]{64}$/.test(name);
}

export function parseDockerVolumeLine(line: string): BuncargoVolume | null {
	const [name, project] = line.split("\t");
	if (!name || isAnonymousVolume(name)) return null;
	return {
		name,
		...(project ? { project } : {}),
		runtime: "docker" as const,
	};
}

export async function listDockerVolumes(
	binary?: string,
): Promise<BuncargoVolume[]> {
	const result = await runDockerAsync(binary, LIST_ARGS);
	if (!result.ok) return [];
	return result.stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			const parsed = parseDockerVolumeLine(line);
			return parsed ? [parsed] : [];
		});
}

/**
 * Remove volumes one at a time.
 *
 * One command per volume rather than one for all of them: `docker volume rm`
 * removes what it can and fails as a whole, so a batch cannot say which of the
 * names it did not get to. Prune reports each one.
 */
export async function removeDockerVolumes(
	names: string[],
	binary?: string,
): Promise<{ name: string; error: string }[]> {
	const failures: { name: string; error: string }[] = [];
	for (const name of names) {
		const result = await runDockerAsync(binary, ["volume", "rm", name], {
			timeoutMs: 30_000,
		});
		if (!result.ok)
			failures.push({
				name,
				error:
					result.stderr.trim() || `docker volume rm exited ${result.exitCode}`,
			});
	}
	return failures;
}
