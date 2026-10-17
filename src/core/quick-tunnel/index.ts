/**
 * Cloudflare Quick Tunnel via the cloudflared CLI (same approach as unjs/untun).
 * License / download flow adapted from unjs/untun (MIT).
 */

import { abortableSleep } from "../deadline";
import {
	quickTunnelMaxAttempts,
	quickTunnelRetryBaseMs,
} from "../runtime-flags";
import { isInstalledTool } from "../tool-binary";
import { startCloudflaredTunnel } from "./cloudflared-process";
import { cloudflaredNotice, resolveCloudflared } from "./constants";
import { installCloudflared } from "./install";

/** True when trycloudflare.com is overloaded / rate-limited or returns non-JSON (cloudflared then errors on unmarshal). */
export function isRetryableQuickTunnelError(message: string): boolean {
	return (
		message.includes("429") ||
		message.includes("Too Many Requests") ||
		message.includes('status_code="429') ||
		// Plain-text "error" or HTML error pages — see cloudflare/cloudflared#972
		message.includes("failed to unmarshal quick Tunnel") ||
		message.includes("failed to unmarshall quick Tunnel") ||
		message.includes("Error unmarshaling QuickTunnel") ||
		message.includes("invalid character '<'") ||
		message.includes("quick tunnel URL timed out")
	);
}

async function startCloudflaredTunnelWithRetry(
	url: string,
	signal?: AbortSignal,
): Promise<ReturnType<typeof startCloudflaredTunnel>> {
	const maxAttempts = quickTunnelMaxAttempts();
	const baseMs = quickTunnelRetryBaseMs();

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		signal?.throwIfAborted();
		const tunnel = startCloudflaredTunnel(url, { signal });
		try {
			await tunnel.url;
			return tunnel;
		} catch (e) {
			try {
				await tunnel.close();
			} catch {
				/* ignore */
			}
			signal?.throwIfAborted();
			const msg = String(e);
			if (attempt < maxAttempts && isRetryableQuickTunnelError(msg)) {
				const delayMs = baseMs * attempt;
				console.log(
					`Cloudflare quick tunnel temporarily unavailable (${attempt}/${maxAttempts}), retrying in ${delayMs}ms…`,
				);
				await abortableSleep(delayMs, signal);
				continue;
			}
			throw e;
		}
	}
	throw new Error("startCloudflaredTunnelWithRetry: exhausted attempts");
}

export interface QuickTunnelOptions {
	url: string;
	signal?: AbortSignal;
}

export interface QuickTunnel {
	getURL: () => Promise<string>;
	close: () => Promise<void>;
}

/**
 * Start a Cloudflare quick tunnel to a local HTTP(S) URL.
 * If the cloudflared binary is missing, prints the license notice and installs it from GitHub.
 */
export async function startQuickTunnel(
	opts: QuickTunnelOptions,
): Promise<QuickTunnel> {
	opts.signal?.throwIfAborted();
	const { url } = opts;

	console.log(`Starting cloudflared tunnel to ${url}`);

	// Throws if BUNCARGO_CLOUDFLARED_PATH is invalid, before anything is spawned.
	const cloudflared = resolveCloudflared();
	if (cloudflared.source === "cache" && !isInstalledTool(cloudflared.path)) {
		console.log(cloudflaredNotice);
		await installCloudflared(cloudflared.path, undefined, {
			signal: opts.signal,
		});
	}

	const tunnel = await startCloudflaredTunnelWithRetry(url, opts.signal);

	const cleanup = async () => {
		await tunnel.close();
	};

	return {
		getURL: async () => await tunnel.url,
		close: cleanup,
	};
}
