/**
 * Download cloudflared from GitHub releases.
 * Derived from unjs/untun (MIT), originally forked from node-cloudflared.
 */
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

const WINDOWS_URL: Partial<Record<NodeJS.Architecture, string>> = {
	x64: "cloudflared-windows-amd64.exe",
	ia32: "cloudflared-windows-386.exe",
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
	const assets =
		process.platform === "linux"
			? LINUX_URL
			: process.platform === "darwin"
				? MACOS_URL
				: process.platform === "win32"
					? WINDOWS_URL
					: undefined;
	const file = assets?.[process.arch];
	if (!file)
		throw new Error(
			`Unsupported cloudflared platform: ${process.platform}/${process.arch}`,
		);
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return installTool({
		to,
		signal: options.signal,
		url: resolveBase(version) + file,
		versionArgs: ["--version"],
		expectedVersion: new RegExp(
			`cloudflared version ${version === "latest" ? "[0-9]+\\.[0-9]+" : escaped}`,
		),
		archiveEntry: process.platform === "darwin" ? "cloudflared" : undefined,
		githubAsset: { repository: "cloudflare/cloudflared", version, name: file },
	});
}
