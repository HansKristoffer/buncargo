import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Prisma's migration chain as folders: `<14-digit UTC timestamp>_<name>`,
 * applied in name order, each with a `migration.sql`.
 */

/**
 * The exit code `buncargo prisma` returns when the database applied
 * migrations the checkout no longer has: only a reset gets past it, and that
 * drops the data, so an agent stops and asks.
 */
export const PRISMA_SQUASHED_CHAIN_EXIT = 4;

const TIMESTAMP = /^(\d{14})_/;

/** The folders under `dir` holding a `migration.sql`, in the order Prisma applies them. */
export async function listMigrationFolders(dir: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const folders: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		try {
			if ((await stat(join(dir, entry.name, "migration.sql"))).isFile())
				folders.push(entry.name);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return folders.sort();
}

function timestampOf(folder: string): string | undefined {
	return TIMESTAMP.exec(folder)?.[1];
}

function formatTimestamp(date: Date): string {
	return date
		.toISOString()
		.replace(/\.\d{3}Z$/, "")
		.replace(/\D/g, "");
}

/**
 * The timestamp for a migration created at `now`: Prisma's format, and later
 * than every folder in `existing`, so it applies last even when the newest
 * one came from a clock ahead of this one.
 */
export function nextMigrationTimestamp(
	existing: readonly string[],
	now: Date,
): string {
	const fromClock = formatTimestamp(now);
	const newest = existing.map(timestampOf).filter(Boolean).sort().at(-1);
	if (newest === undefined || fromClock > newest) return fromClock;
	const iso = newest.replace(
		/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/,
		"$1-$2-$3T$4:$5:$6Z",
	);
	return formatTimestamp(new Date(Date.parse(iso) + 1000));
}

/**
 * What is wrong with the chain `local` against the base branch's `base`: two
 * folders sharing a timestamp, and a folder the base lacks that sorts before
 * its newest, which a database already at the base's tip would never apply
 * in order. Parallel branches produce both.
 */
export function migrationChainProblems(
	local: readonly string[],
	base: readonly string[],
	baseRef: string,
): string[] {
	const problems: string[] = [];
	const byTimestamp = new Map<string, string[]>();
	for (const folder of local) {
		const timestamp = timestampOf(folder);
		if (timestamp === undefined) continue;
		byTimestamp.set(timestamp, [...(byTimestamp.get(timestamp) ?? []), folder]);
	}
	for (const [timestamp, folders] of byTimestamp)
		if (folders.length > 1)
			problems.push(
				`${folders.join(" and ")} share the timestamp ${timestamp}`,
			);

	const onBase = new Set(base);
	const newestOnBase = base
		.filter((folder) => timestampOf(folder) !== undefined)
		.sort()
		.at(-1);
	if (newestOnBase === undefined) return problems;
	for (const folder of local)
		if (!onBase.has(folder) && folder < newestOnBase)
			problems.push(
				`${folder} sorts before ${newestOnBase}, the newest migration on ${baseRef}`,
			);
	return problems;
}

/** The migrations the database finished that `local` no longer has. */
export function appliedButMissing(
	rows: readonly {
		migration_name: string;
		finished_at: unknown | null;
		rolled_back_at: unknown | null;
	}[],
	local: readonly string[],
): string[] {
	const present = new Set(local);
	return rows
		.filter(
			(row) =>
				row.finished_at != null &&
				row.rolled_back_at == null &&
				!present.has(row.migration_name),
		)
		.map((row) => row.migration_name)
		.sort();
}

/**
 * The migration folders under `dir` at `ref`, or undefined when git cannot
 * read the ref. `dir` must exist in the working tree: git resolves the path
 * from it.
 */
export function migrationFoldersAtRef(
	dir: string,
	ref: string,
): string[] | undefined {
	const listed = Bun.spawnSync(
		["git", "ls-tree", "-r", "--name-only", ref, "--", "."],
		{ cwd: dir, stdout: "pipe", stderr: "ignore" },
	);
	if (listed.exitCode !== 0) return undefined;
	return listed.stdout
		.toString()
		.split("\n")
		.map((path) => /^([^/]+)\/migration\.sql$/.exec(path)?.[1])
		.filter((folder): folder is string => folder !== undefined)
		.sort();
}

/**
 * The branch `migration check` compares with when none is named: the
 * remote's default branch, else `origin/main`, else `main`.
 */
export function defaultBaseRef(dir: string): string | undefined {
	const remoteHead = Bun.spawnSync(
		["git", "rev-parse", "--abbrev-ref", "origin/HEAD"],
		{ cwd: dir, stdout: "pipe", stderr: "ignore" },
	);
	const named = remoteHead.stdout.toString().trim();
	if (remoteHead.exitCode === 0 && named !== "" && named !== "origin/HEAD")
		return named;
	for (const ref of ["origin/main", "main"]) {
		const exists = Bun.spawnSync(
			["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
			{ cwd: dir, stdout: "ignore", stderr: "ignore" },
		);
		if (exists.exitCode === 0) return ref;
	}
	return undefined;
}
