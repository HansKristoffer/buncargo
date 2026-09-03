import { join } from "node:path";
import {
	getStateDir,
	type InvokingUser,
	STATE_DIRNAME,
	stateFilePath,
} from "../state-paths";

/**
 * The named-hosts subsystem's own files inside `~/.buncargo`.
 *
 * The directory itself, the home resolution and the `sudo` chown live in
 * `core/state-paths.ts`: the run registry and the menu bar app write there too,
 * so those are not hosts concerns. They are re-exported here because the daemon
 * and the service installer reach for them constantly and are the reason they
 * have to be `sudo`-aware at all.
 */

export {
	chownToInvokingUser,
	type InvokingUser,
	invokingUserIdentity,
	resolveUserHome,
} from "../state-paths";

/** @deprecated Use `STATE_DIRNAME` from `core/state-paths`. */
export const HOSTS_STATE_DIRNAME = STATE_DIRNAME;
export const ROUTES_FILENAME = "routes.json";
export const PIDFILE_FILENAME = "hosts.pid";
export const DAEMON_CONFIG_FILENAME = "hosts-daemon.json";
export const SERVICE_MANIFEST_FILENAME = "hosts-service.json";
export const DECLINE_FILENAME = "hosts-declined";
export const CERTS_DIRNAME = "certs";
export const CERT_FILENAME = "hosts.pem";
export const KEY_FILENAME = "hosts-key.pem";
export const TOOLS_DIRNAME = "bin";

export type { InvokingUser as HostsInvokingUser };

/** @deprecated Use `getStateDir` from `core/state-paths`. */
export const getHostsStateDir = getStateDir;

export function getRoutesPath(home?: string): string {
	return stateFilePath(ROUTES_FILENAME, home);
}

export function getPidfilePath(home?: string): string {
	return stateFilePath(PIDFILE_FILENAME, home);
}

export function getDaemonConfigPath(home?: string): string {
	return stateFilePath(DAEMON_CONFIG_FILENAME, home);
}

export function getServiceManifestPath(home?: string): string {
	return stateFilePath(SERVICE_MANIFEST_FILENAME, home);
}

export function getDeclinePath(home?: string): string {
	return stateFilePath(DECLINE_FILENAME, home);
}

export function getCertsDir(home?: string): string {
	return stateFilePath(CERTS_DIRNAME, home);
}

export function getCertPath(home?: string): string {
	return join(getCertsDir(home), CERT_FILENAME);
}

export function getKeyPath(home?: string): string {
	return join(getCertsDir(home), KEY_FILENAME);
}

/**
 * Where downloaded tools (`mkcert`, `cloudflared`) live.
 *
 * Beside the certificates and the registry rather than in `tmpdir()`: macOS
 * clears `$TMPDIR`, and a cache that disappears takes named hosts down with it
 * — a run that has to widen the certificate for a new worktree hostname finds
 * no `mkcert` and falls back to `localhost:port`.
 */
export function getToolsDir(home?: string): string {
	return stateFilePath(TOOLS_DIRNAME, home);
}
