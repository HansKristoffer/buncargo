import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOSTS_STATE_DIRNAME = ".buncargo";
export const ROUTES_FILENAME = "routes.json";
export const PIDFILE_FILENAME = "hosts.pid";
export const DAEMON_CONFIG_FILENAME = "hosts-daemon.json";
export const DECLINE_FILENAME = "hosts-declined";
export const CERTS_DIRNAME = "certs";
export const CERT_FILENAME = "hosts.pem";
export const KEY_FILENAME = "hosts-key.pem";

export function resolveUserHome(env: NodeJS.ProcessEnv = process.env): string {
	const sudoUser = env.SUDO_USER?.trim();
	if (sudoUser && env.USER === "root") {
		try {
			const home = execSync(
				`dscl . -read /Users/${sudoUser} NFSHomeDirectory`,
				{
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				},
			)
				.split(":")
				.pop()
				?.trim();
			if (home) return home;
		} catch {
			// Linux getent
		}
		try {
			const line = execSync(`getent passwd ${sudoUser}`, {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
			const home = line.split(":")[5];
			if (home) return home;
		} catch {
			// fall through
		}
	}
	return env.HOME?.trim() || homedir();
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

export function chownToInvokingUser(
	path: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const uid = env.SUDO_UID;
	const gid = env.SUDO_GID;
	if (!uid || process.getuid?.() !== 0) {
		return;
	}
	try {
		execSync(`chown ${uid}:${gid || uid} "${path}"`, {
			stdio: "ignore",
		});
	} catch {
		// Best-effort; unprivileged later writes will surface the problem.
	}
}
