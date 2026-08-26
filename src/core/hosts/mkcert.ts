import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkcertPathOverride, mkcertVersion } from "../runtime-flags";
import { resolveToolBinary } from "../tool-binary";
import {
	chownToInvokingUser,
	getCertPath,
	getCertsDir,
	getKeyPath,
} from "./paths";

export const MKCERT_RELEASE_BASE =
	"https://github.com/FiloSottile/mkcert/releases/";

const RENEW_BEFORE_MS = 1000 * 60 * 60 * 24 * 30;

export function cachedMkcertBinPath(version = mkcertVersion()): string {
	const name =
		process.platform === "win32"
			? `mkcert.${version}.exe`
			: `mkcert.${version}`;
	return join(tmpdir(), "buncargo-mkcert", name);
}

export function resolvedMkcertPath(): string | undefined {
	const resolution = resolveToolBinary({
		override: mkcertPathOverride(),
		cachePath: cachedMkcertBinPath(),
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
	mkdirSync(join(dest, ".."), { recursive: true });
	const url = `${MKCERT_RELEASE_BASE}download/${version}/${mkcertAssetName(version)}`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download mkcert (${response.status}): ${url}`);
	}
	await Bun.write(dest, await response.arrayBuffer());
	chmodSync(dest, 0o755);
	return dest;
}

export function getCaRoot(mkcertPath?: string): string | undefined {
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

export function getCaPath(mkcertPath?: string): string | undefined {
	const root = getCaRoot(mkcertPath);
	if (!root) return undefined;
	const pem = join(root, "rootCA.pem");
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
		if (hostnames.some((hostname) => !covered.has(hostname))) {
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
	mkdirSync(getCertsDir(), { recursive: true });
	execFileSync(
		mkcertPath,
		["-cert-file", certPath, "-key-file", keyPath, ...unique],
		{
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
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
