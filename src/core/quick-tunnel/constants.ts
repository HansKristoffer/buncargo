/**
 * Paths and release metadata for the cloudflared binary.
 * Derived from unjs/untun (MIT), originally forked from node-cloudflared.
 */

import { tmpdir } from "node:os";
import path from "node:path";
import { cloudflaredPathOverride, cloudflaredVersion } from "../runtime-flags";
import { resolveToolBinary, type ToolBinaryResolution } from "../tool-binary";

export const RELEASE_BASE =
	"https://github.com/cloudflare/cloudflared/releases/";

/** Cache path for buncargo-managed cloudflared (avoid clashing with untun's node-untun). */
export function cloudflaredBinPath(version = cloudflaredVersion()): string {
	return path.join(
		tmpdir(),
		"buncargo-cloudflared",
		process.platform === "win32"
			? `cloudflared.${version}.exe`
			: `cloudflared.${version}`,
	);
}

/**
 * Spawn/install target: optional `BUNCARGO_CLOUDFLARED_PATH` overrides the
 * bundled cache path. No `PATH` lookup — buncargo pins the release it downloads.
 */
export function resolveCloudflared(): ToolBinaryResolution {
	return resolveToolBinary({
		override: cloudflaredPathOverride(),
		cachePath: cloudflaredBinPath(),
	});
}

export function resolvedCloudflaredBinPath(): string {
	return resolveCloudflared().path;
}

export const cloudflaredNotice = `
🔥 Your installation of cloudflared software constitutes a symbol of your signature
 indicating that you accept the terms of the Cloudflare License, Terms and Privacy Policy.

❯ License: \`https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/license/\`
❯ Terms: \`https://www.cloudflare.com/terms/\`
❯ Privacy Policy: \`https://www.cloudflare.com/privacypolicy/\`
`;
