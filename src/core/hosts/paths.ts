import { execSync } from "node:child_process";
import { chownSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOSTS_STATE_DIRNAME = ".buncargo";
export const ROUTES_FILENAME = "routes.json";
export const PIDFILE_FILENAME = "hosts.pid";
export const DAEMON_CONFIG_FILENAME = "hosts-daemon.json";
export const SERVICE_MANIFEST_FILENAME = "hosts-service.json";
export const DECLINE_FILENAME = "hosts-declined";
export const CERTS_DIRNAME = "certs";
export const CERT_FILENAME = "hosts.pem";
export const KEY_FILENAME = "hosts-key.pem";

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

export function getHostsStateDir(home = resolveUserHome()): string {
	return join(home, HOSTS_STATE_DIRNAME);
}

export function getRoutesPath(home = resolveUserHome()): string {
	return join(getHostsStateDir(home), ROUTES_FILENAME);
}

export function getPidfilePath(home = resolveUserHome()): string {
	return join(getHostsStateDir(home), PIDFILE_FILENAME);
}

export function getDaemonConfigPath(home = resolveUserHome()): string {
	return join(getHostsStateDir(home), DAEMON_CONFIG_FILENAME);
}

export function getServiceManifestPath(home = resolveUserHome()): string {
	return join(getHostsStateDir(home), SERVICE_MANIFEST_FILENAME);
}

export function getDeclinePath(home = resolveUserHome()): string {
	return join(getHostsStateDir(home), DECLINE_FILENAME);
}

export function getCertsDir(home = resolveUserHome()): string {
	return join(getHostsStateDir(home), CERTS_DIRNAME);
}

export function getCertPath(home = resolveUserHome()): string {
	return join(getCertsDir(home), CERT_FILENAME);
}

export function getKeyPath(home = resolveUserHome()): string {
	return join(getCertsDir(home), KEY_FILENAME);
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
