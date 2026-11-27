import { getErrorMessage } from "hanzio";
import { withFileLock } from "../file-lock";
import { rememberCertNames } from "./cert-names";
import {
	certNeedsRenewal,
	hostnamesForCertificate,
} from "./certificate-inspect";
import { ensureMkcert, mintCert, resolvedMkcertPath } from "./mkcert";
import { getCertPath } from "./paths";
import { loadHostRoutes } from "./registry";

export {
	certificateFingerprint,
	certificateServes,
	describeCertificateGap,
	describeCertificateShortfall,
	hostnamesForCertificate,
	readCertificatePair,
} from "./certificate-inspect";

/**
 * Minting the leaf certificate the :443 proxy serves.
 *
 * This is deliberately CLI-side work. The daemon runs as root under
 * launchd/systemd, where Homebrew is not on `PATH` and shelling out is the one
 * thing a supervised root process should avoid; the CLI runs as the user, where
 * `mkcert` resolves the same way it does interactively.
 *
 * One certificate covers every registered hostname on the machine, so whichever
 * run last changed the registry mints for the union.
 */

export interface CertificateFiles {
	certPath: string;
	keyPath: string;
}

/**
 * How long one mint may take. It runs under the certificate lock, which every
 * other run's named hosts wait on, so a hung mkcert must not hold it.
 */
const MINT_TIMEOUT_MS = 30_000;

/** Where a mint gets `mkcert`: the binary already installed, or a download. */
export interface MkcertSource {
	installed: () => string | undefined;
	download: () => Promise<string>;
}

export const machineMkcert: MkcertSource = {
	installed: resolvedMkcertPath,
	download: ensureMkcert,
};

/**
 * Download `mkcert` for a mint that is due.
 *
 * A cache that has been cleared must not cost a developer their named URLs.
 * The download is a user-owned file and the CA is already trusted, so this
 * asks for no password: only installing the service does.
 */
async function downloadMkcert(mkcert: MkcertSource): Promise<string> {
	try {
		return await mkcert.download();
	} catch (error) {
		const message = getErrorMessage(error);
		throw new Error(
			`mkcert is not available and could not be downloaded (${message}). Run \`buncargo hosts install\`.`,
		);
	}
}

/**
 * Ensure the proxy certificate covers every hostname in the registry, plus any
 * in `include` that this run is about to register.
 *
 * Held under a lock on the certificate itself. Two runs starting together would
 * otherwise both shell out to `mkcert` over the same two files while the daemon
 * polls them. The renewal check runs inside the lock, so the run that waits
 * finds the winner's certificate already sufficient and mints nothing.
 *
 * Returns the cert paths, downloading `mkcert` when a mint is due and none is
 * installed, or throwing with an actionable message when even that fails.
 * Most runs need no mint, and pay for no download: a mint that finds no binary
 * releases the lock, downloads, and checks again. Callers on the `buncargo
 * dev` path treat a failure as "fall back to localhost:port", not as a fatal
 * error.
 */
export async function syncCertificateForRoutes(
	mkcert: MkcertSource,
	options: {
		include?: string[];
		/**
		 * Repo root `include` belongs to. Given, the names are remembered for
		 * it, so this project keeps its coverage while it is not running.
		 */
		root?: string;
	} = {},
): Promise<CertificateFiles> {
	const certPath = getCertPath();
	const include = options.include ?? [];
	let mkcertPath = mkcert.installed();

	for (;;) {
		const result = await withFileLock(certPath, async () => {
			const routes = await loadHostRoutes();

			// Remembered names as well as live routes: a certificate minted from
			// the registry alone loses a project's names the moment it stops, and
			// reminting on its next run rebinds the daemon and drops every other
			// project's websockets.
			const remembered = await rememberCertNames({
				root: options.root,
				names: include,
			});
			const hostnames = [
				...new Set([
					...routes.map((route) => route.hostname),
					...include,
					...remembered,
				]),
			].sort();
			const wanted = hostnamesForCertificate(hostnames);

			// Resolving/downloading a tool can take minutes. Release the lock
			// so the daemon can go on reading the last valid certificate, then
			// recompute the union, which a concurrent run may have widened.
			if (!mkcertPath && certNeedsRenewal(certPath, wanted)) return undefined;

			const minted = mintCert(wanted, {
				mkcertPath,
				timeoutMs: MINT_TIMEOUT_MS,
			});
			return { certPath: minted.certPath, keyPath: minted.keyPath };
		});

		if (result) return result;

		mkcertPath = await downloadMkcert(mkcert);
	}
}
