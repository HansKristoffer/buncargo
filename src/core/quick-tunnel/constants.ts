/**
 * Paths and release metadata for the cloudflared binary.
 * Derived from unjs/untun (MIT), originally forked from node-cloudflared.
 */

import { tmpdir } from "node:os";
import path from "node:path";

export const CLOUDFLARED_VERSION =
	process.env.CLOUDFLARED_VERSION || "2023.10.0";

export const RELEASE_BASE =
	"https://github.com/cloudflare/cloudflared/releases/";

/** Directory for buncargo-managed cloudflared (avoid clashing with untun's node-untun). */
export const cloudflaredBinPath = path.join(
	tmpdir(),
	"buncargo-cloudflared",
	process.platform === "win32"
		? `cloudflared.${CLOUDFLARED_VERSION}.exe`
		: `cloudflared.${CLOUDFLARED_VERSION}`,
);

export const cloudflaredNotice = `
🔥 Your installation of cloudflared software constitutes a symbol of your signature
 indicating that you accept the terms of the Cloudflare License, Terms and Privacy Policy.

❯ License: \`https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/license/\`
❯ Terms: \`https://www.cloudflare.com/terms/\`
❯ Privacy Policy: \`https://www.cloudflare.com/privacypolicy/\`
`;
