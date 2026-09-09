import { toolCachePath } from "../tool-binary";
import { installTool } from "../tool-install";
export const FRP_VERSION = "0.71.0";
const checksums: Record<string, string> = {
	linux_amd64:
		"84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716",
	linux_arm64:
		"f33c293c275d8fc68c654b6fba8f10b2551d6463d09a9fc9cffb7227eae82266",
	darwin_amd64:
		"1b1b4e2f1836e21e8733f1dddaacd4ed9ae67d7dbee39046b9d7b7eda6253637",
	darwin_arm64:
		"45be02b186860d375ed49a8941ae9569628a54bf14e67fc36b29c98c99dabcc6",
};
export async function installFrp(
	name: "frpc" | "frps" = "frpc",
	signal?: AbortSignal,
) {
	const platform = `${process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
	const sha256 = checksums[platform];
	if (!sha256)
		throw new Error(
			"frp supports macOS and Linux on x64/arm64; use WSL on Windows.",
		);
	const release = `frp_${FRP_VERSION}_${platform}`;
	return installTool({
		to: toolCachePath(`${release}/${name}`),
		url: `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${release}.tar.gz`,
		archiveEntry: `${release}/${name}`,
		sha256,
		versionArgs: ["--version"],
		expectedVersion: /^0\.71\.0\s*$/,
		signal,
	});
}
