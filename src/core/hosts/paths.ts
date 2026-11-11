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
export const TAILSCALE_SERVE_FILENAME = "tailscale-serve.json";

export function getRoutesPath(): string {
	return stateFilePath(ROUTES_FILENAME);
}

/** Every Tailscale Serve entry buncargo added (`BUNCARGO_HOSTS=tailscale`). */
export function getTailscaleServePath(): string {
	return stateFilePath(TAILSCALE_SERVE_FILENAME);
}

export function getPidfilePath(): string {
	return stateFilePath(PIDFILE_FILENAME);
}

export function getDaemonConfigPath(): string {
	return stateFilePath(DAEMON_CONFIG_FILENAME);
}

export function getServiceManifestPath(): string {
	return stateFilePath(SERVICE_MANIFEST_FILENAME);
}

export function getCertsDir(): string {
	return stateFilePath(CERTS_DIRNAME);
}

export function getCertPath(): string {
	return join(getCertsDir(), CERT_FILENAME);
}

export function getKeyPath(): string {
	return join(getCertsDir(), KEY_FILENAME);
}
