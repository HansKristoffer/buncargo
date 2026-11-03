import { writeSync } from "node:fs";
import { relative } from "node:path";
import { connectProcessEnv } from "../core/child-env";
import { withFileLockSync } from "../core/file-lock";
import { INSTALLING_ENV } from "../core/runtime-flags";
import { projectStateFilePath } from "../core/state-paths";
import { CliError } from "./errors";
import { lockfileHash, writeInstallStamp } from "./install-stamp";
import { type InstallNeed, installNeed } from "./version-guard";

/** A cold install of a large monorepo, postinstall scripts included. */
const INSTALL_LOCK_TIMEOUT_MS = 10 * 60_000;

const INSTALL_COMMAND = "bun install --frozen-lockfile";

/**
 * `bun install --frozen-lockfile` in the checkout, before the command it was
 * asked for. The project's postinstall scripts (`prisma generate`) run as part
 * of it.
 *
 * Its output goes to stderr, so a `--json` command's stdout stays one JSON
 * document. Agents in several terminals of one worktree install once: the
 * others wait on the checkout's lock and find it done.
 */
export function installCheckout(need: InstallNeed): void {
	withFileLockSync(
		projectStateFilePath(need.dir, "install"),
		() => {
			// Another buncargo may have installed while this one waited.
			if (!installNeed(need.dir)) return;
			const hash = lockfileHash(need.dir);
			const where = relative(process.cwd(), need.dir) || ".";
			writeSync(
				2,
				`buncargo: ${need.reason} in ${where}; running ${INSTALL_COMMAND}\n`,
			);

			const result = Bun.spawnSync(
				[process.execPath, "install", "--frozen-lockfile"],
				{
					cwd: need.dir,
					stdin: "ignore",
					stdout: 2,
					stderr: "inherit",
					env: { ...connectProcessEnv(), [INSTALLING_ENV]: "1" },
				},
			);
			if (result.exitCode !== 0) {
				const failure = `${INSTALL_COMMAND} failed in ${need.dir} (exit ${result.exitCode}); its output is above.`;
				throw new CliError(failure, [
					`Fix what it reports, run \`bun install\` in ${need.dir}, then run the command again.`,
				]);
			}

			// A frozen install leaves bun.lock as it was.
			if (hash !== undefined) writeInstallStamp(need.dir, hash);
		},
		{ timeoutMs: INSTALL_LOCK_TIMEOUT_MS },
	);
}
