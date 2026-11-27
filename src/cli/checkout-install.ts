import { writeSync } from "node:fs";
import { relative } from "node:path";
import { connectProcessEnv } from "../core/child-env";
import { withFileLockSync } from "../core/file-lock";
import { detectPackageManager } from "../core/package-manager";
import { INSTALLING_ENV } from "../core/runtime-flags";
import { projectStateFilePath } from "../core/state-paths";
import { CliError } from "./errors";
import { lockfileStamp, writeInstallStamp } from "./install-stamp";
import { type InstallNeed, installNeed } from "./version-guard";

/** A cold install of a large monorepo, postinstall scripts included. */
const INSTALL_LOCK_TIMEOUT_MS = 10 * 60_000;

/**
 * Frozen-lockfile install in the checkout (`bun install --frozen-lockfile`,
 * `pnpm install --frozen-lockfile`, …), before the command it was asked for.
 * The project's postinstall scripts (`prisma generate`) run as part of it.
 *
 * `stillNeeded` is asked again under the checkout's lock: by default, whether
 * the dependencies still predate the lockfile.
 *
 * Its output goes to stderr, so a `--json` command's stdout stays one JSON
 * document. Agents in several terminals of one worktree install once: the
 * others wait on the checkout's lock and find it done.
 */
export function installCheckout(
	need: InstallNeed,
	stillNeeded: () => boolean = () => installNeed(need.dir) !== undefined,
): void {
	withFileLockSync(
		projectStateFilePath(need.dir, "install"),
		() => {
			// Another buncargo may have installed while this one waited.
			if (!stillNeeded()) return;

			const manager = detectPackageManager(need.dir);
			const stamp = lockfileStamp(need.dir);
			const where = relative(process.cwd(), need.dir) || ".";
			writeSync(
				2,
				`buncargo: ${need.reason} in ${where}; running ${manager.frozenInstallDisplay}\n`,
			);

			const args = manager.frozenInstallArgs();
			let result: ReturnType<typeof Bun.spawnSync>;
			try {
				result = Bun.spawnSync(args, {
					cwd: need.dir,
					stdin: "ignore",
					stdout: 2,
					stderr: "inherit",
					env: { ...connectProcessEnv(), [INSTALLING_ENV]: "1" },
				});
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				throw new CliError(
					`Could not run \`${manager.frozenInstallDisplay}\` in ${need.dir}: ${detail}`,
					[
						`Install ${manager.name} on PATH, then run \`${manager.installCommand}\` in ${need.dir}.`,
					],
				);
			}

			if (result.exitCode !== 0) {
				const failure = `${manager.frozenInstallDisplay} failed in ${need.dir} (exit ${result.exitCode}); its output is above.`;
				throw new CliError(failure, [
					`Fix what it reports, run \`${manager.installCommand}\` in ${need.dir}, then run the command again.`,
				]);
			}

			// A frozen install leaves the lockfile as it was.
			if (stamp !== undefined) writeInstallStamp(need.dir, stamp);
		},
		{ timeoutMs: INSTALL_LOCK_TIMEOUT_MS },
	);
}
