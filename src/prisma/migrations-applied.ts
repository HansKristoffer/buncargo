import { resolve } from "node:path";
import { withDeadline, withSignal } from "../core/deadline";
import type { PrismaConfig, ResolvedService } from "../types";
import { resolvePrismaConfig } from "./config";
import { appliedButMissing, listMigrationFolders } from "./migration-chain";

export interface MigrationRow {
	migration_name: string;
	finished_at: unknown | null;
	rolled_back_at: unknown | null;
}

/** Read all rows so failed/rolled-back attempts cannot be hidden by an applied row. */
export async function readMigrationRows(
	url: string,
	signal?: AbortSignal,
): Promise<MigrationRow[]> {
	return withDeadline(
		async (querySignal) => {
			// Node consumers can import the library without loading this Bun-only shortcut.
			const { SQL } = await import("bun");
			querySignal.throwIfAborted();
			const sql = new SQL(url, { max: 1, connectionTimeout: 2 });
			const query = sql<
				MigrationRow[]
			>`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`.execute();
			const cancel = () => query.cancel();
			querySignal.addEventListener("abort", cancel, { once: true });
			try {
				return await withSignal(query, querySignal);
			} finally {
				querySignal.removeEventListener("abort", cancel);
				await sql.close({ timeout: 0 });
			}
		},
		2000,
		signal,
	);
}

/** Undefined means deploy must decide. This is a shortcut, never a migration validator. */
export async function appliedMigrationCount(
	input: {
		root: string;
		prisma: Pick<PrismaConfig, "cwd" | "migrations">;
		service: ResolvedService;
		url?: string;
		signal?: AbortSignal;
	},
	readRows = readMigrationRows,
): Promise<number | undefined> {
	input.signal?.throwIfAborted();
	if (input.service.preset !== "postgres" || !input.url) return;
	try {
		const url = new URL(input.url);
		if (
			!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
			!["postgres:", "postgresql:"].includes(url.protocol)
		)
			return;
		const { cwd, migrations } = resolvePrismaConfig(input.prisma);
		const local = await listMigrationFolders(
			resolve(input.root, cwd, migrations),
		);
		if (local.length === 0) return;
		const rows = await readRows(input.url, input.signal);
		if (
			rows.some((row) => row.finished_at == null || row.rolled_back_at != null)
		)
			return;
		const applied = new Set(rows.map((row) => row.migration_name));
		return local.every((name) => applied.has(name)) ? local.length : undefined;
	} catch {
		input.signal?.throwIfAborted();
		return undefined;
	}
}

/**
 * The migrations the database at `url` finished that `dir` no longer has,
 * as when a branch squashed the chain. Undefined when the database cannot
 * say (unreachable, no `_prisma_migrations`): Prisma then decides.
 */
export async function missingAppliedMigrations(
	url: string,
	dir: string,
	readRows = readMigrationRows,
): Promise<string[] | undefined> {
	try {
		return appliedButMissing(
			await readRows(url),
			await listMigrationFolders(dir),
		);
	} catch {
		return undefined;
	}
}
