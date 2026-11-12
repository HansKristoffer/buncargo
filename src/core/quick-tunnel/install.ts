/**
 * Download cloudflared from GitHub releases.
 * Derived from unjs/untun (MIT), originally forked from node-cloudflared.
 */
import { escapeRegExp, typedSwitch } from "hanzio";
import { cloudflaredVersion } from "../runtime-flags";
import { installTool } from "../tool-install";
import { cloudflaredBinPath, RELEASE_BASE } from "./constants";

const LINUX_URL: Partial<Record<NodeJS.Architecture, string>> = {
	arm64: "cloudflared-linux-arm64",
	arm: "cloudflared-linux-arm",
	x64: "cloudflared-linux-amd64",
	ia32: "cloudflared-linux-386",
};

const MACOS_URL: Partial<Record<NodeJS.Architecture, string>> = {
	arm64: "cloudflared-darwin-arm64.tgz",
	x64: "cloudflared-darwin-amd64.tgz",
};

/**
 * sha256 of each asset for the default version, from the digests GitHub
 * records on the 2026.3.0 release assets. The release notes' list hashes the
 * binary inside each macOS `.tgz`, not the `.tgz` downloaded here.
 */
const PINNED_SHA256: Record<string, string> = {
	"2026.3.0/cloudflared-linux-arm64":
		"0755ba4cbab59980e6148367fcf53a8f3ec85a97deefd63c2420cf7850769bee",
	"2026.3.0/cloudflared-linux-arm":
		"ca16ed5253373846f7d366d591669d0e868e0724e35599abad2c8b2bc2340cfa",
	"2026.3.0/cloudflared-linux-amd64":
		"4a9e50e6d6d798e90fcd01933151a90bf7edd99a0a55c28ad18f2e16263a5c30",
	"2026.3.0/cloudflared-linux-386":
		"7d59f6ef7b4c255edd88187c74d2b4ecd895b6f5c4aca2cae0c4411eacebcbbd",
	"2026.3.0/cloudflared-darwin-arm64.tgz":
		"2aae4f69b0fc1c671b8353b4f594cbd902cd1e360c8eed2b8cad4602cb1546fb",
	"2026.3.0/cloudflared-darwin-amd64.tgz":
		"0f30140c4a5e213d22f951ef4c964cac5fb6a5f061ba6eba5ea932999f7c0394",
};

function resolveBase(version: string): string {
	if (version === "latest") {
		return `${RELEASE_BASE}latest/download/`;
	}
	return `${RELEASE_BASE}download/${version}/`;
}

export async function installCloudflared(
	to: string = cloudflaredBinPath(),
	version = cloudflaredVersion(),
	options: { signal?: AbortSignal } = {},
): Promise<string> {
	const assets = typedSwitch(
		process.platform,
		{
			linux: () => LINUX_URL,
			darwin: () => MACOS_URL,
		},
		() => undefined,
	);
	const file = assets?.[process.arch];
	if (!file)
		throw new Error(
			`Unsupported cloudflared platform: ${process.platform}/${process.arch}`,
		);
	const escaped = escapeRegExp(version);
	return installTool({
		to,
		signal: options.signal,
		url: resolveBase(version) + file,
		versionArgs: ["--version"],
		expectedVersion: new RegExp(
			`cloudflared version ${version === "latest" ? "[0-9]+\\.[0-9]+" : escaped}`,
		),
		archiveEntry: process.platform === "darwin" ? "cloudflared" : undefined,
		sha256: PINNED_SHA256[`${version}/${file}`] ?? {
			repository: "cloudflare/cloudflared",
			version,
			name: file,
			settings: {
				version: "CLOUDFLARED_VERSION",
				path: "BUNCARGO_CLOUDFLARED_PATH",
			},
		},
	});
}
