import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { SQL } from "bun";
import { withDeadline, withSignal } from "../core/deadline";
import { inferDockerPreset } from "../core/service-presets";
import type { PrismaConfig, ServiceConfig } from "../types";

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
		serviceKey: string;
		service: ServiceConfig;
		url?: string;
		signal?: AbortSignal;
	},
	readRows = readMigrationRows,
): Promise<number | undefined> {
	input.signal?.throwIfAborted();
	if (
		inferDockerPreset(input.serviceKey, input.service) !== "postgres" ||
		!input.url
	)
		return;
	try {
		const url = new URL(input.url);
		if (
			!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
			!["postgres:", "postgresql:"].includes(url.protocol)
		)
			return;
		const directory = resolve(
			input.root,
			input.prisma.cwd ?? "packages/prisma",
			input.prisma.migrations ?? "prisma/migrations",
		);
		const entries = await readdir(directory, { withFileTypes: true });
		const local: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			try {
				if (
					(await stat(resolve(directory, entry.name, "migration.sql"))).isFile()
				)
					local.push(entry.name);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
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
