import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { withFileLock } from "../../file-lock";
import { tailcatPath } from "../../runtime-flags";
import {
	finalizeToolBinary,
	resolveToolBinary,
	toolCachePath,
} from "../../tool-binary";
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
		"Automatic Tailcat installation supports Apple silicon and Linux x64/arm64. Set BUNCARGO_TAILCAT_PATH to a Tailcat 0.6.0 binary on this platform.",
	);
}
export async function ensureTailcat(signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const resolved = resolveToolBinary({
		override: tailcatPath(),
		cachePath: toolCachePath(
			`tailcat-${TAILCAT_VERSION}-${process.platform}-${process.arch}`,
		),
	});
	if (resolved.exists) return resolved.path;
	if (resolved.source === "override")
		throw new Error("BUNCARGO_TAILCAT_PATH does not exist");
	const asset = tailcatAsset();
	await mkdir(dirname(resolved.path), { recursive: true });
	return withFileLock(
		resolved.path,
		async () => {
			try {
				await readFile(resolved.path);
				return resolved.path;
			} catch {}
			const dir = await mkdtemp(join(dirname(resolved.path), ".tailcat-"));
			try {
				const response = await fetch(asset.url, {
					headers: asset.headers,
					signal: AbortSignal.any([
						AbortSignal.timeout(120_000),
						...(signal ? [signal] : []),
					]),
				});
				if (!response.ok)
					throw new Error(`Tailcat download failed (${response.status})`);
				const bytes = Buffer.from(await response.arrayBuffer());
				if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
					throw new Error("Tailcat download checksum mismatch");
				const archive = join(dir, "download.tar.gz");
				await writeFile(archive, bytes);
				await promisify(execFile)("tar", [
					"-xzf",
					archive,
					"-C",
					dir,
					asset.member,
				]);
				const binary = join(dir, asset.member);
				finalizeToolBinary(binary);
				await rename(binary, resolved.path);
				return resolved.path;
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
		{ timeoutMs: 150_000, signal },
	);
}
