import { execSync } from "node:child_process";
import { chownSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where buncargo keeps state on disk, in one place.
 *
 * Two directories, deliberately named the same:
 *
 * - `~/.buncargo/` is machine-wide — the hosts route registry, the run
 *   registry, the daemon config and the downloaded tools. Every checkout on
 *   the machine shares it, so entries carry an owner and are pruned.
 * - `<root>/.buncargo/` is per-checkout — the port lockfile, the tunnel
 *   registry, typecheck timings. It is `.gitignore`d and disposable.
 *
 * Both used to be joined by hand at each call site, which is how the same
 * directory ended up with hosts-flavored names for files the hosts subsystem
 * does not own. Path getters live here; the filenames stay with the module
 * that owns each file.
 *
 * The user-identity helpers live here too because they are what makes a path
 * correct under `sudo`: the daemon runs as root and must still read and write
 * the invoking user's `~/.buncargo`.
 */

export const STATE_DIRNAME = ".buncargo";

export interface InvokingUser {
	user: string;
	uid: number;
	gid: number;
	home: string;
}

export function invokingUserIdentity(
	env: NodeJS.ProcessEnv = process.env,
	ids: { uid?: number; gid?: number } = {},
): InvokingUser {
	const uid = ids.uid ?? process.getuid?.() ?? -1;
	const gid = ids.gid ?? process.getgid?.() ?? -1;
	const sudoUser = sudoUserWhenElevated(env, uid);
	if (sudoUser) {
		return {
			user: sudoUser,
			uid: Number.parseInt(env.SUDO_UID ?? "", 10) || uid,
			gid: Number.parseInt(env.SUDO_GID ?? "", 10) || gid,
			home: resolveUserHome(env, uid),
		};
	}
	return {
		user: env.USER?.trim() || env.LOGNAME?.trim() || "unknown",
		uid,
		gid,
		home: resolveUserHome(env, uid),
	};
}

/**
 * The user behind a `sudo` invocation, or `undefined` when not elevated.
 *
 * `resolveUserHome` and `invokingUserIdentity` must agree on this, or the
 * daemon gets root's home with the invoking user's uid.
 */
function sudoUserWhenElevated(
	env: NodeJS.ProcessEnv,
	uid: number | undefined,
): string | undefined {
	const sudoUser = env.SUDO_USER?.trim();
	if (!sudoUser) return undefined;
	return env.USER === "root" || uid === 0 ? sudoUser : undefined;
}

/** Homes that mean "root's own", not the invoking user's. */
const ROOT_HOMES = new Set(["/var/root", "/root"]);

const HOME_LOOKUP_TIMEOUT_MS = 2000;

/** Empty string records a lookup that already failed, so it is not retried. */
const homeLookupCache = new Map<string, string>();

function runHomeLookup(command: string): string | undefined {
	try {
		return execSync(command, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: HOME_LOOKUP_TIMEOUT_MS,
		}).trim();
	} catch {
		return undefined;
	}
}

/**
 * Ask the platform where a user's home is, at most once per user.
 *
 * Every call forks, and forking repeatedly out of a multithreaded runtime can
 * deadlock the child before it reaches `exec`, so this must stay off any hot
 * path — see {@link resolveUserHome}.
 */
function lookupUserHome(user: string): string | undefined {
	const cached = homeLookupCache.get(user);
	if (cached !== undefined) return cached || undefined;

	const fromDirectoryService = runHomeLookup(
		`dscl . -read /Users/${user} NFSHomeDirectory`,
	)
		?.split(":")
		.pop()
		?.trim();
	const fromPasswd = fromDirectoryService
		? undefined
		: runHomeLookup(`getent passwd ${user}`)?.split(":")[5]?.trim();

	const home = fromDirectoryService || fromPasswd;
	homeLookupCache.set(user, home ?? "");
	return home;
}

export function resolveUserHome(
	env: NodeJS.ProcessEnv = process.env,
	uid: number | undefined = process.getuid?.(),
): string {
	const sudoUser = sudoUserWhenElevated(env, uid);
	const home = env.HOME?.trim();
	if (!sudoUser) return home || homedir();

	// A caller that already put the invoking user's home in HOME means it, and
	// the launchd/systemd service does exactly that. Looking the user up anyway
	// would fork on every path getter below, several times per second in the
	// daemon's reload loop, and those forks deadlock the daemon.
	if (home && !ROOT_HOMES.has(home)) return home;

	return lookupUserHome(sudoUser) ?? home ?? homedir();
}

/**
 * `~/.buncargo` — machine-wide state shared by every checkout.
 *
 * Relocated by pointing `HOME` somewhere else, which is how the tests keep off
 * the developer's real registry. Deliberately not a dedicated override: a
 * second mechanism that outranks `HOME` leaks between test files, and the
 * hosts daemon resolves this path independently under `sudo`.
 */
export function getStateDir(home = resolveUserHome()): string {
	return join(home, STATE_DIRNAME);
}

/** A file directly inside {@link getStateDir}. */
export function stateFilePath(
	filename: string,
	home = resolveUserHome(),
): string {
	return join(getStateDir(home), filename);
}

/** `<root>/.buncargo` — per-checkout state, gitignored and disposable. */
export function getProjectStateDir(root: string): string {
	return join(root, STATE_DIRNAME);
}

/** A file directly inside {@link getProjectStateDir}. */
export function projectStateFilePath(root: string, filename: string): string {
	return join(getProjectStateDir(root), filename);
}

/** Causes already reported, so a per-second daemon write logs once. */
const reportedChownFailures = new Set<string>();

/**
 * Hand a root-written file back to the invoking user.
 *
 * Uses `chownSync` rather than shelling out to `chown`: this runs after every
 * write the daemon makes, and forking that often out of a multithreaded
 * runtime can deadlock before the child reaches `exec`.
 *
 * A failure is not fatal here but is never harmless: the file stays root-owned
 * and the user's next `buncargo dev` fails to write it with a bare `EACCES`
 * that points nowhere. Only reachable under `sudo`, where stderr is the
 * service log.
 */
export function chownToInvokingUser(
	path: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const uid = Number.parseInt(env.SUDO_UID ?? "", 10);
	if (!Number.isInteger(uid) || process.getuid?.() !== 0) {
		return;
	}
	const gid = Number.parseInt(env.SUDO_GID ?? "", 10);
	try {
		chownSync(path, uid, Number.isInteger(gid) ? gid : uid);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const key = `${path}:${message}`;
		if (reportedChownFailures.has(key)) return;
		reportedChownFailures.add(key);
		try {
			writeSync(
				2,
				`[buncargo hosts] ${path} is still owned by root: ${message}\n`,
			);
		} catch {
			// stderr is gone; the EACCES on the next user write is all that is left
		}
	}
}
