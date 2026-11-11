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
const PIDFILE_FILENAME = "hosts.pid";
const SERVICE_MANIFEST_FILENAME = "hosts-service.json";
export const DECLINE_FILENAME = "hosts-declined";
const CERTS_DIRNAME = "certs";
const CERT_FILENAME = "hosts.pem";
const KEY_FILENAME = "hosts-key.pem";
const TAILSCALE_SERVE_FILENAME = "tailscale-serve.json";

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

export function getServiceManifestPath(): string {
	return stateFilePath(SERVICE_MANIFEST_FILENAME);
}

function getCertsDir(): string {
	return stateFilePath(CERTS_DIRNAME);
}

export function getCertPath(): string {
	return join(getCertsDir(), CERT_FILENAME);
}

export function getKeyPath(): string {
	return join(getCertsDir(), KEY_FILENAME);
}
