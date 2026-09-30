import { formatFail } from "../core/style";
import type { MigrationConfig } from "../types";

export async function runMigrationsSequentially(
	migrations: MigrationConfig[],
	exec: (
		command: string,
		options?: {
			cwd?: string;
			throwOnError?: boolean;
			secrets?: MigrationConfig["secrets"];
		},
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
	skip?: (migration: MigrationConfig) => Promise<boolean>,
): Promise<void> {
	for (const migration of migrations) {
		if (await skip?.(migration)) continue;
		const result = await exec(migration.command, {
			cwd: migration.cwd,
			throwOnError: false,
			// Undefined falls back to the config-level scope inside exec.
			secrets: migration.secrets,
		});
		if (result.exitCode !== 0) {
			console.error(formatFail(`Migration "${migration.name}" failed`));
			if (result.stdout) {
				console.error(result.stdout);
			}
			if (result.stderr) {
				console.error(result.stderr);
			}
			throw new Error(`Migration "${migration.name}" failed`);
		}
	}
}
