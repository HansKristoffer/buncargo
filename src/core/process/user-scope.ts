import { existsSync } from "node:fs";
import { join } from "node:path";
import { systemdScopeEnabled } from "../runtime-flags";
import { lookupOnPath } from "../tool-binary";

/**
 * `argv` wrapped to run in a systemd user scope of its own, when the machine
 * has a user manager; `argv` unchanged otherwise.
 *
 * On Linux a process lives in its parent's cgroup, `detached` or not. Under a
 * harness that runs as a `systemctl --user` service (T3 Code on a server),
 * restarting that service kills every process in its cgroup: the watchdog,
 * `dev --detach` runs and their apps. A scope is a cgroup of its own under the
 * user manager, so they outlive it, and with lingering, a logout too.
 *
 * `systemd-run --scope` execs the command in place, so the caller's pid is the
 * process's own and the environment passes through unchanged.
 */
export function inOwnUserScope(
	argv: readonly string[],
	description: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (platform !== "linux" || !systemdScopeEnabled(env)) return [...argv];
	const runtimeDir = env.XDG_RUNTIME_DIR;
	if (!runtimeDir || !existsSync(join(runtimeDir, "systemd", "private")))
		return [...argv];
	const systemdRun = lookupOnPath("systemd-run", env);
	if (!systemdRun) return [...argv];
	return [
		systemdRun,
		"--user",
		"--scope",
		"--collect",
		"--quiet",
		`--description=${description}`,
		"--",
		...argv,
	];
}
