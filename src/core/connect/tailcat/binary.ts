import { tailcatPath } from "../../runtime-flags";
import { resolveToolBinary, toolCachePath } from "../../tool-binary";
import { installTool } from "../../tool-install";

export const TAILCAT_VERSION = "0.6.0";
const linux = {
	x64: "f3597a9ad02f5cca538f8f5a6f89123910bce3e9611d1e5a8e96d5f2d3cc90fd",
	arm64: "fff48f25d223aea31f985bae8a2c01378b22e51e985e8c7d270e1a8586598506",
};
/** Pinned upstream Linux releases and the relocatable Homebrew macOS bottle. */
export function tailcatAsset(platform = process.platform, arch = process.arch) {
	if (platform === "linux" && (arch === "x64" || arch === "arm64"))
		return {
			url: `https://github.com/tailscale/tailcat/releases/download/v${TAILCAT_VERSION}/tailcat_${TAILCAT_VERSION}_linux_${arch === "x64" ? "amd64" : arch}.tar.gz`,
			sha256: linux[arch],
			member: "tailcat",
			headers: {} as Record<string, string>,
		};
	if (platform === "darwin" && arch === "arm64") {
		const sha256 =
			"f91c1798eb7e91de6ea3cdea482c467e4810f607393af82080d743461228a345";
		return {
			url: `https://ghcr.io/v2/homebrew/core/tailcat/blobs/sha256:${sha256}`,
			sha256,
			member: `tailcat/${TAILCAT_VERSION}/bin/tailcat`,
			headers: { authorization: "Bearer QQ==" },
		};
	}
	throw new Error(
		`Automatic Tailcat installation supports Apple silicon and Linux x64/arm64. Set BUNCARGO_TAILCAT_PATH to a Tailcat ${TAILCAT_VERSION} binary on this platform.`,
	);
}
/** Tailcat supplies asset metadata; the shared installer owns verification and atomic caching. */
export async function ensureTailcat(signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const resolved = resolveToolBinary({
		override: tailcatPath(),
		cachePath: toolCachePath(
			`tailcat-${TAILCAT_VERSION}-${process.platform}-${process.arch}`,
		),
	});
	if (resolved.source === "override") {
		if (!resolved.exists)
			throw new Error("BUNCARGO_TAILCAT_PATH does not exist");
		return resolved.path;
	}
	const asset = tailcatAsset();
	return installTool({
		to: resolved.path,
		url: asset.url,
		sha256: asset.sha256,
		archiveEntry: asset.member,
		versionArgs: ["--version"],
		expectedVersion: new RegExp(
			`^v?${TAILCAT_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`,
		),
		signal,
		fetch: (url, options) => {
			const headers = new Headers(options.headers);
			// The Homebrew registry's anonymous authorization must not follow cross-origin redirects.
			if (new URL(url).origin === new URL(asset.url).origin)
				for (const [name, value] of Object.entries(asset.headers))
					headers.set(name, value);
			return fetch(url, { ...options, headers });
		},
	});
}
