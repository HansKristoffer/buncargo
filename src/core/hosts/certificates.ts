import { existsSync, statSync } from "node:fs";
import { getErrorMessage, typedSwitch } from "hanzio";
import { FileLockTimeoutError, withFileLock } from "../file-lock";
import { rememberCertNames } from "./cert-names";
import {
	type CertificateShortfall,
	certificateShortfall,
	certNeedsRenewal,
	ensureMkcert,
	mintCert,
	parseCertificateLeaf,
	readCertificateLeaf,
	resolvedMkcertPath,
} from "./mkcert";
import { getCertPath, getKeyPath } from "./paths";
import { certificateCovers } from "./plan";
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

/**
 * How long the daemon waits on a mint before trying again on a later pass.
 * Short, because every other project's route changes queue behind it.
 */
const PAIR_READ_LOCK_MS = 1000;

/**
 * Read the pair the proxy binds, under the same lock minting takes, or
 * `undefined` while a mint holds it.
 *
 * Landing a new certificate is two renames, not one. An unlocked reader can
 * fall between them and pair a fresh certificate with the previous key, which
 * fails the TLS bind and takes every named URL down until the next reload.
 *
 * A held lock is a mint in progress, not a failure: `mkcert` runs under it,
 * and treating a slow one as a failed reload backed the daemon off. The mint
 * ends in a rename the daemon watches, which brings it straight back here.
 */
export async function readCertificatePair(): Promise<
	{ cert: string; key: string } | undefined
> {
	const certPath = getCertPath();
	const keyPath = getKeyPath();
	try {
		return await withFileLock(
			certPath,
			async () => ({
				cert: await Bun.file(certPath).text(),
				key: await Bun.file(keyPath).text(),
			}),
			{ timeoutMs: PAIR_READ_LOCK_MS },
		);
	} catch (error) {
		if (error instanceof FileLockTimeoutError) return undefined;
		throw error;
	}
}

/**
 * Which hostnames a bound certificate answers for, at a given moment, or
 * `undefined` when its names or expiry cannot be read.
 *
 * What the daemon reports as served. A route the listener's own leaf does not
 * cover, or any route once that leaf has expired, fails TLS in the browser
 * however complete the route map is, and a health body that listed it anyway
 * let a run advertise https URLs that could not load.
 *
 * Unreadable is not "serves nothing": `Bun.serve` accepted the certificate,
 * and answering nothing would send every run on the machine to
 * `localhost:port` without a word. The daemon falls back to the route map.
 */
export function certificateServes(
	certPem: string,
): ((hostname: string, now: number) => boolean) | undefined {
	const leaf = parseCertificateLeaf(certPem);
	if (leaf === undefined || Number.isNaN(leaf.validTo)) return undefined;
	return (hostname, now) =>
		leaf.validTo > now && certificateCovers(leaf.names, hostname);
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
	const leaf = readCertificateLeaf(certPath);
	if (!leaf) {
		return `Named-hosts certificate at ${certPath} could not be read. Run \`buncargo hosts install\`.`;
	}
	const shortfall = certificateShortfall(
		leaf,
		hostnamesForCertificate(hostnames),
	);
	return shortfall && describeCertificateShortfall(shortfall);
}

/**
 * Say which of the two reasons applies. An expiring certificate covers every
 * name, so reporting it as "does not cover" sends someone looking for a
 * hostname problem that is not there.
 */
export function describeCertificateShortfall(
	shortfall: CertificateShortfall,
	now = Date.now(),
): string {
	return typedSwitch(shortfall, "kind", {
		uncovered: ({ hostnames }) =>
			`Named-hosts certificate does not cover ${hostnames.join(", ")}. Run \`buncargo hosts install\`.`,
		expiring: ({ validTo }) => {
			const day = Number.isFinite(validTo)
				? new Date(validTo).toISOString().slice(0, 10)
				: undefined;
			const when = !day
				? "has no readable expiry date"
				: validTo <= now
					? `expired on ${day}`
					: `expires on ${day}`;
			return `Named-hosts certificate ${when}. The next \`buncargo dev\` renews it, or run \`buncargo hosts install\`.`;
		},
	});
}

/**
 * A cheap identity for the certificate on disk.
 *
 * The daemon polls this to notice a certificate the CLI reminted underneath it
 * and rebind with the new leaf, without parsing the file every second. The
 * inode is part of it: a mint lands by rename, so it always changes, where two
 * mints of one size within the filesystem's mtime granularity look alike.
 */
export function certificateFingerprint(
	certPath = getCertPath(),
	keyPath = getKeyPath(),
): string {
	return [certPath, keyPath]
		.map((path) => {
			try {
				const stat = statSync(path);
				return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
			} catch {
				return "missing";
			}
		})
		.join("|");
}
