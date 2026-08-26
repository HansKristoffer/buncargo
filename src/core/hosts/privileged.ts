import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * Running the handful of root operations named hosts needs: writing a unit
 * file under `/Library/LaunchDaemons` or `/etc/systemd`, and loading it.
 *
 * Everything goes through one interface so install/uninstall can be tested
 * against a recording runner instead of prompting for a real password.
 */

export interface PrivilegedRunOptions {
	stdio?: "inherit" | "ignore";
}

export interface PrivilegedRunner {
	/** Already root (a service context), so `sudo` is unnecessary. */
	isRoot: () => boolean;
	/** Prime credentials up front so later calls do not re-prompt mid-install. */
	authorize: () => void;
	run: (
		command: string,
		args: string[],
		options?: PrivilegedRunOptions,
	) => void;
	writeFile: (path: string, contents: string) => void;
	/** Remove a root-owned path; a missing file is not an error. */
	removeFile: (path: string) => void;
}

export function systemPrivilegedRunner(): PrivilegedRunner {
	const isRoot = () => process.getuid?.() === 0;

	const run: PrivilegedRunner["run"] = (command, args, options = {}) => {
		const stdio = options.stdio ?? "ignore";
		if (isRoot()) {
			execFileSync(command, args, { stdio });
			return;
		}
		execFileSync("sudo", [command, ...args], { stdio });
	};

	return {
		isRoot,
		authorize() {
			if (isRoot()) return;
			execFileSync("sudo", ["-v"], { stdio: "inherit" });
		},
		run,
		writeFile(path, contents) {
			if (isRoot()) {
				writeFileSync(path, contents, { mode: 0o644 });
				return;
			}
			// Stage inside a 0700 directory. A predictable path in a shared /tmp
			// would let a local user plant a symlink and steer what root copies
			// into a file it later executes.
			const dir = mkdtempSync(join(tmpdir(), "buncargo-service-"));
			const staged = join(dir, basename(path));
			try {
				writeFileSync(staged, contents, { mode: 0o644 });
				run("cp", [staged, path]);
				run("chmod", ["644", path]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		removeFile(path) {
			run("rm", ["-f", path]);
		},
	};
}
