import { toolCachePath } from "../tool-binary";
import { installTool } from "../tool-install";

export const TAILSCALE_VERSION = "1.102.3";
const checksums = {
	x64: "36ddd9b51be57ffc2990cf76323cfa13643bfbb1b8a969f6183fa164741cdef5",
	arm64: "a0fa1b154af8c61f862a2259f559f7396d96c0225f4a863eae2333e1546bbe25",
};

/** Official static Linux builds need neither root, a package manager, nor a TUN device. */
export async function installTailscale(signal?: AbortSignal) {
	const arch = process.arch;
	if (process.platform !== "linux" || (arch !== "x64" && arch !== "arm64"))
		throw new Error(
			"Automatic Tailscale enrollment supports Linux x64/arm64. Install and sign in to Tailscale on this computer.",
		);
	const release = `tailscale_${TAILSCALE_VERSION}_${arch === "x64" ? "amd64" : arch}`;
	const install = (name: string) =>
		installTool({
			to: toolCachePath(`${release}/${name}`),
			url: `https://pkgs.tailscale.com/stable/${release}.tgz`,
			archiveEntry: `${release}/${name}`,
			sha256: checksums[arch],
			versionArgs: ["--version"],
			expectedVersion: new RegExp(
				`^${TAILSCALE_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`,
			),
			signal,
		});
	const binary = await install("tailscale");
	return { binary, daemon: await install("tailscaled") };
}
