import { join } from "node:path";
import { stateFilePath } from "../state-paths";

/**
 * The named-hosts subsystem's own files inside `~/.buncargo`.
 *
 * The directory itself, the home resolution and the `sudo` chown live in
 * `core/state-paths.ts`: the run registry and the menu bar app write there too,
 * so those are not hosts concerns.
 */

export const ROUTES_FILENAME = "routes.json";
export const PIDFILE_FILENAME = "hosts.pid";
export const DAEMON_CONFIG_FILENAME = "hosts-daemon.json";
export const SERVICE_MANIFEST_FILENAME = "hosts-service.json";
export const DECLINE_FILENAME = "hosts-declined";
export const CERTS_DIRNAME = "certs";
export const CERT_FILENAME = "hosts.pem";
export const KEY_FILENAME = "hosts-key.pem";

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

export function getCertsDir(home?: string): string {
	return stateFilePath(CERTS_DIRNAME, home);
}

export function getCertPath(home?: string): string {
	return join(getCertsDir(home), CERT_FILENAME);
}

export function getKeyPath(home?: string): string {
	return join(getCertsDir(home), KEY_FILENAME);
}
