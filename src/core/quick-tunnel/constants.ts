/**
 * Paths and release metadata for the cloudflared binary.
 * Derived from unjs/untun (MIT), originally forked from node-cloudflared.
 */

import { cloudflaredPathOverride, cloudflaredVersion } from "../runtime-flags";
import {
	legacyToolCachePath,
	resolveToolBinary,
	type ToolBinaryResolution,
	toolCachePath,
} from "../tool-binary";

export const RELEASE_BASE =
	"https://github.com/cloudflare/cloudflared/releases/";

const LEGACY_CLOUDFLARED_CACHE_DIRNAME = "buncargo-cloudflared";

function cloudflaredFileName(version: string): string {
	return process.platform === "win32"
		? `cloudflared.${version}.exe`
		: `cloudflared.${version}`;
}

/** Cache path for buncargo-managed cloudflared (avoid clashing with untun's node-untun). */
export function cloudflaredBinPath(version = cloudflaredVersion()): string {
	return toolCachePath(cloudflaredFileName(version));
}

/** The `tmpdir()` cache earlier versions downloaded into. */
export function legacyCloudflaredBinPath(
	version = cloudflaredVersion(),
): string {
	return legacyToolCachePath(
		LEGACY_CLOUDFLARED_CACHE_DIRNAME,
		cloudflaredFileName(version),
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
		legacyCachePath: legacyCloudflaredBinPath(),
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
