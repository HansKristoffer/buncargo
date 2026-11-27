import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { typedSwitch } from "hanzio";
import { FileLockTimeoutError, withFileLock } from "../file-lock";
import { getCertPath, getKeyPath } from "./paths";
import { certificateCovers } from "./plan";

/**
 * Read-only inspection of the proxy's TLS leaf certificate.
 *
 * Kept separate from `certificates.ts` and `mkcert.ts` so the root `hostsd`
 * daemon never bundles CLI-only mkcert downloading, minting, or `cert-names`
 * registry machinery.
 */

/** A leaf with less than this left is reminted on the next `buncargo dev`. */
const RENEW_BEFORE_MS = 1000 * 60 * 60 * 24 * 30;

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

/** The parts of a leaf certificate renewal depends on. */
interface CertificateLeaf {
	names: Set<string>;
	/** Expiry in epoch milliseconds; `NaN` when the certificate has none. */
	validTo: number;
}

/** The leaf in a PEM, or `undefined` when it is not one. */
function parseCertificateLeaf(
	pem: string | Buffer,
): CertificateLeaf | undefined {
	try {
		const cert = new X509Certificate(pem);
		const names = new Set(
			(cert.subjectAltName ?? "")
				.split(",")
				.map((part) => part.trim().replace(/^DNS:/i, ""))
				.filter(Boolean),
		);
		return { names, validTo: Date.parse(cert.validTo) };
	} catch {
		return undefined;
	}
}

/** The leaf at `certPath`, or `undefined` when it is missing or unreadable. */
function readCertificateLeaf(certPath: string): CertificateLeaf | undefined {
	try {
		return parseCertificateLeaf(readFileSync(certPath));
	} catch {
		return undefined;
	}
}

/** Why a leaf needs reminting for `hostnames`, or `undefined` when it does not. */
type CertificateShortfall =
	| { kind: "uncovered"; hostnames: string[] }
	| { kind: "expiring"; validTo: number };

export function certificateShortfall(
	leaf: CertificateLeaf,
	hostnames: string[],
	now = Date.now(),
): CertificateShortfall | undefined {
	// Wildcard-aware: a leaf carrying `*.myapp.localhost` already serves a
	// new worktree's hostname, and treating that as a gap would remint on
	// every fresh checkout, the churn wildcards exist to avoid.
	const uncovered = hostnames.filter(
		(hostname) => !certificateCovers(leaf.names, hostname),
	);
	if (uncovered.length > 0) return { kind: "uncovered", hostnames: uncovered };

	if (!Number.isFinite(leaf.validTo) || leaf.validTo - now < RENEW_BEFORE_MS) {
		return { kind: "expiring", validTo: leaf.validTo };
	}

	return undefined;
}

export function certNeedsRenewal(
	certPath: string,
	hostnames: string[],
	now = Date.now(),
): boolean {
	if (hostnames.length === 0) return true;

	const leaf = readCertificateLeaf(certPath);
	return !leaf || certificateShortfall(leaf, hostnames, now) !== undefined;
}

/**
 * How long the daemon waits on a mint before trying again on a later pass.
 * Short, because every other project's route changes queue behind it.
 */
const PAIR_READ_LOCK_MS = 1000;

/**
 * Read the pair the proxy binds, under the same lock minting takes, or
 * `undefined` while a mint holds it.
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
				return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
			} catch {
				return "missing";
			}
		})
		.join("|");
}
