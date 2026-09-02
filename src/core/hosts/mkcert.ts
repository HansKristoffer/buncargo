import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { mkcertPathOverride, mkcertVersion } from "../runtime-flags";
import {
	finalizeToolBinary,
	legacyToolCachePath,
	resolveToolBinary,
	toolCachePath,
} from "../tool-binary";
import {
	chownToInvokingUser,
	getCertPath,
	getKeyPath,
	resolveUserHome,
} from "./paths";
import { certificateCovers } from "./plan";

export const MKCERT_RELEASE_BASE =
	"https://github.com/FiloSottile/mkcert/releases/";

const RENEW_BEFORE_MS = 1000 * 60 * 60 * 24 * 30;

const LEGACY_MKCERT_CACHE_DIRNAME = "buncargo-mkcert";

function mkcertFileName(version: string): string {
	return process.platform === "win32"
		? `mkcert.${version}.exe`
		: `mkcert.${version}`;
}

export function cachedMkcertBinPath(version = mkcertVersion()): string {
	return toolCachePath(mkcertFileName(version));
}

/** The `tmpdir()` cache earlier versions downloaded into. */
export function legacyMkcertBinPath(version = mkcertVersion()): string {
	return legacyToolCachePath(
		LEGACY_MKCERT_CACHE_DIRNAME,
		mkcertFileName(version),
	);
}

export function resolvedMkcertPath(): string | undefined {
	const resolution = resolveToolBinary({
		override: mkcertPathOverride(),
		cachePath: cachedMkcertBinPath(),
		legacyCachePath: legacyMkcertBinPath(),
		pathCommand: "mkcert",
	});
	return resolution.exists ? resolution.path : undefined;
}

function mkcertAssetName(version: string): string {
	if (process.platform === "darwin") {
		return process.arch === "arm64"
			? `mkcert-${version}-darwin-arm64`
			: `mkcert-${version}-darwin-amd64`;
	}
	if (process.platform === "linux") {
		return process.arch === "arm64"
			? `mkcert-${version}-linux-arm64`
			: `mkcert-${version}-linux-amd64`;
	}
	throw new Error(`mkcert download is not supported on ${process.platform}`);
}

export async function ensureMkcert(): Promise<string> {
	const existing = resolvedMkcertPath();
	if (existing) return existing;

	const version = mkcertVersion();
	const dest = cachedMkcertBinPath(version);
	mkdirSync(dirname(dest), { recursive: true });
	const url = `${MKCERT_RELEASE_BASE}download/${version}/${mkcertAssetName(version)}`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download mkcert (${response.status}): ${url}`);
	}
	await Bun.write(dest, await response.arrayBuffer());
	finalizeToolBinary(dest);
	return dest;
}

export const CA_FILENAME = "rootCA.pem";

/**
 * Where mkcert keeps its CA, by its own documented rules, without asking it.
 *
 * `$CAROOT` wins, then the per-platform data directory. Every `buncargo dev`
 * with named hosts on needs this path, and `mkcert -CAROOT` is a fork that
 * answers the same question — one this can answer from the environment for
 * every machine that has not moved it.
 */
export function caRootCandidates(
	env: NodeJS.ProcessEnv = process.env,
	home = resolveUserHome(env),
): string[] {
	const explicit = env.CAROOT?.trim();
	if (explicit) return [explicit];

	if (process.platform === "darwin") {
		return [join(home, "Library", "Application Support", "mkcert")];
	}
	if (process.platform === "win32") {
		const localAppData = env.LOCALAPPDATA?.trim();
		return localAppData ? [join(localAppData, "mkcert")] : [];
	}
	const xdg = env.XDG_DATA_HOME?.trim();
	return [
		...(xdg ? [join(xdg, "mkcert")] : []),
		join(home, ".local", "share", "mkcert"),
	];
}

/** Ask mkcert itself. Only reached when the CA is not where it should be. */
function caRootFromBinary(mkcertPath?: string): string | undefined {
	const bin = mkcertPath ?? resolvedMkcertPath();
	if (!bin) return undefined;
	try {
		return execFileSync(bin, ["-CAROOT"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return undefined;
	}
}

export function getCaRoot(mkcertPath?: string): string | undefined {
	for (const candidate of caRootCandidates()) {
		if (existsSync(join(candidate, CA_FILENAME))) return candidate;
	}
	// Nothing where it should be: either the CA has never been installed, or
	// this machine moved it. Only now is the fork worth it.
	return caRootFromBinary(mkcertPath);
}

export function getCaPath(mkcertPath?: string): string | undefined {
	const root = getCaRoot(mkcertPath);
	if (!root) return undefined;
	const pem = join(root, CA_FILENAME);
	return existsSync(pem) ? pem : undefined;
}

export function isCaPresent(mkcertPath?: string): boolean {
	return getCaPath(mkcertPath) !== undefined;
}

export function certNeedsRenewal(
	certPath: string,
	hostnames: string[],
	now = Date.now(),
): boolean {
	if (!existsSync(certPath) || hostnames.length === 0) return true;
	try {
		const cert = new X509Certificate(readFileSync(certPath));
		const alt = cert.subjectAltName ?? "";
		const covered = new Set(
			alt
				.split(",")
				.map((part) => part.trim().replace(/^DNS:/i, ""))
				.filter(Boolean),
		);
		// Wildcard-aware: a leaf carrying `*.myapp.localhost` already serves a
		// new worktree's hostname, and treating that as a gap would remint on
		// every fresh checkout — the churn wildcards exist to avoid.
		if (hostnames.some((hostname) => !certificateCovers(covered, hostname))) {
			return true;
		}
		const expires = Date.parse(cert.validTo);
		if (!Number.isFinite(expires) || expires - now < RENEW_BEFORE_MS) {
			return true;
		}
		return false;
	} catch {
		return true;
	}
}

export function mintCert(
	hostnames: string[],
	options: { mkcertPath?: string; certPath?: string; keyPath?: string } = {},
): { certPath: string; keyPath: string; minted: boolean } {
	const unique = [...new Set(hostnames)].sort();
	const certPath = options.certPath ?? getCertPath();
	const keyPath = options.keyPath ?? getKeyPath();
	if (!certNeedsRenewal(certPath, unique)) {
		return { certPath, keyPath, minted: false };
	}
	const mkcertPath = options.mkcertPath ?? resolvedMkcertPath();
	if (!mkcertPath) {
		throw new Error("mkcert is not available. Run buncargo hosts install.");
	}
	mkdirSync(dirname(certPath), { recursive: true });
	mkdirSync(dirname(keyPath), { recursive: true });

	// Mint beside the live files and rename in: the daemon polls these paths
	// every second, and mkcert writing them in place lets it read a PEM that is
	// still being written. Rename is atomic, so a reader sees old or new.
	const stamp = `${process.pid}.${Date.now()}`;
	const pendingCert = `${certPath}.${stamp}.tmp`;
	const pendingKey = `${keyPath}.${stamp}.tmp`;
	try {
		execFileSync(
			mkcertPath,
			["-cert-file", pendingCert, "-key-file", pendingKey, ...unique],
			{
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		// Key first. Two renames are two steps, and the certificate is what
		// moves the fingerprint the daemon rebinds on, so landing it last means
		// a rebind never pairs the new certificate with the previous key.
		renameSync(pendingKey, keyPath);
		renameSync(pendingCert, certPath);
	} finally {
		rmSync(pendingCert, { force: true });
		rmSync(pendingKey, { force: true });
	}

	chownToInvokingUser(certPath);
	chownToInvokingUser(keyPath);
	return { certPath, keyPath, minted: true };
}

export function installTrust(mkcertPath?: string): void {
	const bin = mkcertPath ?? resolvedMkcertPath();
	if (!bin) {
		throw new Error("mkcert is not available");
	}
	execFileSync(bin, ["-install"], { stdio: "inherit" });
}

export function uninstallTrust(mkcertPath?: string): void {
	const bin = mkcertPath ?? resolvedMkcertPath();
	if (!bin) return;
	try {
		execFileSync(bin, ["-uninstall"], { stdio: "inherit" });
	} catch {
		// CA may already be gone
	}
}
