import { existsSync, statSync } from "node:fs";
import { withFileLock } from "../file-lock";
import { rememberCertNames } from "./cert-names";
import {
	certNeedsRenewal,
	ensureMkcert,
	mintCert,
	resolvedMkcertPath,
} from "./mkcert";
import { getCertPath, getKeyPath } from "./paths";
import { loadHostRoutes } from "./registry";

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

/**
 * Always on the leaf, so the proxy can bind before any route exists.
 *
 * Not merely a placeholder for the empty case. The daemon asks for coverage of
 * whatever is registered, which becomes exactly this the moment the last
 * project stops. A leaf minted for project hostnames alone is then reported as
 * a gap on every poll, and the backoff widens to 30s, so the next project waits
 * that long for the rebind that picks up its certificate.
 */
const ALWAYS_COVERED = ["localhost"];

export function hostnamesForCertificate(hostnames: string[]): string[] {
	return [...new Set([...ALWAYS_COVERED, ...hostnames])].sort();
}

export interface CertificateFiles {
	certPath: string;
	keyPath: string;
}

/**
 * The binary to mint with, downloading it when a mint is actually due.
 *
 * `deps` exists so the three branches can be tested without a network call.
 *
 * A cache that has been cleared must not cost a developer their named URLs.
 * The download is a user-owned file and the CA is already trusted, so this
 * asks for no password — only installing the service does. Returning
 * `undefined` when nothing needs minting keeps the no-op path free of a
 * network call: `mintCert` never looks at the binary in that case.
 */
export async function resolveMkcertForMint(
	certPath: string,
	wanted: string[],
	deps: {
		resolve?: () => string | undefined;
		needsRenewal?: () => boolean;
		download?: () => Promise<string>;
	} = {},
): Promise<string | undefined> {
	const existing = (deps.resolve ?? resolvedMkcertPath)();
	if (existing) return existing;
	const needsRenewal =
		deps.needsRenewal ?? (() => certNeedsRenewal(certPath, wanted));
	if (!needsRenewal()) return undefined;
	try {
		return await (deps.download ?? ensureMkcert)();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
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
 * Returns the cert paths, downloading `mkcert` first when a mint is due and
 * none is installed, or throwing with an actionable message when even that
 * fails. Callers on the `buncargo dev` path treat a failure as "fall back to
 * localhost:port", not as a fatal error.
 */
export async function syncCertificateForRoutes(
	options: {
		mkcertPath?: string;
		include?: string[];
		/**
		 * Repo root `include` belongs to. Given, the names are remembered for
		 * it, so this project keeps its coverage while it is not running.
		 */
		root?: string;
	} = {},
): Promise<CertificateFiles> {
	const certPath = getCertPath();
	return withFileLock(certPath, async () => {
		const routes = await loadHostRoutes();
		// Remembered names as well as live routes: a certificate minted from
		// the registry alone loses a project's names the moment it stops, and
		// reminting on its next run rebinds the daemon and drops every other
		// project's websockets.
		const remembered = await rememberCertNames({
			root: options.root,
			names: options.include ?? [],
		});
		const hostnames = [
			...new Set([
				...routes.map((route) => route.hostname),
				...(options.include ?? []),
				...remembered,
			]),
		].sort();
		const wanted = hostnamesForCertificate(hostnames);
		const mkcertPath =
			options.mkcertPath ?? (await resolveMkcertForMint(certPath, wanted));
		const minted = mintCert(wanted, { mkcertPath });
		return { certPath: minted.certPath, keyPath: minted.keyPath };
	});
}

/**
 * Read the pair the proxy binds, under the same lock minting takes.
 *
 * Landing a new certificate is two renames, not one. An unlocked reader can
 * fall between them and pair a fresh certificate with the previous key, which
 * fails the TLS bind and takes every named URL down until the next reload.
 */
export async function readCertificatePair(): Promise<{
	cert: string;
	key: string;
}> {
	const certPath = getCertPath();
	const keyPath = getKeyPath();
	return withFileLock(certPath, async () => ({
		cert: await Bun.file(certPath).text(),
		key: await Bun.file(keyPath).text(),
	}));
}

/**
 * Why the daemon cannot serve these hostnames with the certificate on disk.
 *
 * The daemon reports this instead of minting: it has no business spawning
 * `mkcert` as root, and the CLI that registered the route is the process that
 * should have refreshed the certificate.
 */
export function describeCertificateGap(
	hostnames: string[],
	certPath = getCertPath(),
): string | undefined {
	if (!existsSync(certPath)) {
		return `Named-hosts certificate is missing at ${certPath}. Run \`buncargo hosts install\`.`;
	}
	const wanted = hostnamesForCertificate(hostnames);
	if (certNeedsRenewal(certPath, wanted)) {
		return `Named-hosts certificate does not cover ${wanted.join(", ")}. Run \`buncargo hosts install\`.`;
	}
	return undefined;
}

/**
 * A cheap identity for the certificate on disk.
 *
 * The daemon polls this to notice a certificate the CLI reminted underneath it
 * and rebind with the new leaf, without parsing the file every second.
 */
export function certificateFingerprint(
	certPath = getCertPath(),
	keyPath = getKeyPath(),
): string {
	return [certPath, keyPath]
		.map((path) => {
			try {
				const stat = statSync(path);
				return `${stat.mtimeMs}:${stat.size}`;
			} catch {
				return "missing";
			}
		})
		.join("|");
}
