import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Running the handful of root operations named hosts needs: writing a unit
 * file under `/Library/LaunchDaemons` or `/etc/systemd`, and loading it.
 *
 * Everything goes through one interface so install/uninstall can be tested
 * against a recording runner instead of prompting for a real password.
 */

interface PrivilegedRunOptions {
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
	/**
	 * A root-owned file's contents, or `undefined` when it does not exist.
	 * Needs no privilege (the files are world-readable); it is here so an
	 * install can put back what it replaced.
	 */
	readFile: (path: string) => string | undefined;
}

/** Runs one command, throwing when it fails: `execFileSync`, in production. */
export type PrivilegedExec = (
	command: string,
	args: string[],
	options: { stdio: "inherit" | "ignore" },
) => void;

export function systemPrivilegedRunner(): PrivilegedRunner {
	return createPrivilegedRunner({
		isRoot: () => process.getuid?.() === 0,
		exec: (command, args, options) => {
			execFileSync(command, args, options);
		},
	});
}

/**
 * The runner over one way of executing a command, so the commands it issues
 * can be checked without `sudo`.
 */
export function createPrivilegedRunner(deps: {
	isRoot: () => boolean;
	exec: PrivilegedExec;
}): PrivilegedRunner {
	const { isRoot, exec } = deps;

	const run: PrivilegedRunner["run"] = (command, args, options = {}) => {
		const stdio = options.stdio ?? "ignore";
		if (isRoot()) {
			exec(command, args, { stdio });
			return;
		}
		exec("sudo", [command, ...args], { stdio });
	};

	return {
		isRoot,
		authorize() {
			if (isRoot()) return;
			exec("sudo", ["-v"], { stdio: "inherit" });
		},
		run,
		writeFile(path, contents) {
			// Lands by a rename from a sibling: a reader sees the old file or the
			// new one, never a truncated one. `/etc/hosts` goes through here, and
			// every name resolution on the machine reads it.
			const sibling = join(
				dirname(path),
				`.${basename(path)}.buncargo-${process.pid}.tmp`,
			);
			if (isRoot()) {
				try {
					writeFileSync(sibling, contents, { mode: 0o644 });
					renameSync(sibling, path);
				} catch (error) {
					rmSync(sibling, { force: true });
					throw error;
				}
				return;
			}
			// Stage inside a 0700 directory. A predictable path in a shared /tmp
			// would let a local user plant a symlink and steer what root copies
			// into a file it later executes. The sibling sits in a root-owned
			// directory, where no other user can plant anything.
			const dir = mkdtempSync(join(tmpdir(), "buncargo-service-"));
			const staged = join(dir, basename(path));
			try {
				writeFileSync(staged, contents, { mode: 0o644 });
				run("cp", [staged, sibling]);
				run("chmod", ["644", sibling]);
				run("mv", ["-f", sibling, path]);
			} catch (error) {
				try {
					run("rm", ["-f", sibling]);
				} catch {
					// Report the failure that explains why.
				}
				throw error;
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		removeFile(path) {
			run("rm", ["-f", path]);
		},
		readFile(path) {
			try {
				return readFileSync(path, "utf-8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT")
					return undefined;
				throw error;
			}
		},
	};
}
