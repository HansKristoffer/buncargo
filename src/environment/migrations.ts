import type { MigrationConfig } from "../types";

export async function runMigrationsSequentially(
	migrations: MigrationConfig[],
	exec: (
		command: string,
		options?: { cwd?: string; throwOnError?: boolean },
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<void> {
	for (const migration of migrations) {
		const result = await exec(migration.command, {
			cwd: migration.cwd,
			throwOnError: false,
		});
		if (result.exitCode !== 0) {
			console.error(`❌ Migration "${migration.name}" failed`);
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
