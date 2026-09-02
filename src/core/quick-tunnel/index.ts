/**
 * Cloudflare Quick Tunnel via the cloudflared CLI (same approach as unjs/untun).
 * License / download flow adapted from unjs/untun (MIT).
 */
import {
	quickTunnelMaxAttempts,
	quickTunnelRetryBaseMs,
} from "../runtime-flags";
import { sleep } from "../sleep";
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
	cfArgs: Record<string, string | number | null>,
): Promise<ReturnType<typeof startCloudflaredTunnel>> {
	const maxAttempts = quickTunnelMaxAttempts();
	const baseMs = quickTunnelRetryBaseMs();

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const tunnel = startCloudflaredTunnel(cfArgs);
		try {
			await tunnel.url;
			return tunnel;
		} catch (e) {
			try {
				tunnel.stop();
			} catch {
				/* ignore */
			}
			const msg = String(e);
			if (attempt < maxAttempts && isRetryableQuickTunnelError(msg)) {
				const delayMs = baseMs * attempt;
				console.log(
					`Cloudflare quick tunnel temporarily unavailable (${attempt}/${maxAttempts}), retrying in ${delayMs}ms…`,
				);
				await sleep(delayMs);
				continue;
			}
			throw e;
		}
	}
	throw new Error("startCloudflaredTunnelWithRetry: exhausted attempts");
}

export interface QuickTunnelOptions {
	url?: string;
	port?: number | string;
	hostname?: string;
	protocol?: "http" | "https";
	verifyTLS?: boolean;
}

export interface QuickTunnel {
	getURL: () => Promise<string>;
	close: () => Promise<void>;
}

function resolvedLocalUrl(opts: QuickTunnelOptions): string {
	return (
		opts.url ??
		`${opts.protocol || "http"}://${opts.hostname ?? "localhost"}:${opts.port ?? 3000}`
	);
}

/**
 * Start a Cloudflare quick tunnel to a local HTTP(S) URL.
 * If the cloudflared binary is missing, prints the license notice and installs it from GitHub.
 */
export async function startQuickTunnel(
	opts: QuickTunnelOptions,
): Promise<QuickTunnel> {
	const url = resolvedLocalUrl(opts);

	console.log(`Starting cloudflared tunnel to ${url}`);

	// Throws if BUNCARGO_CLOUDFLARED_PATH is invalid, before anything is spawned.
	const cloudflared = resolveCloudflared();
	if (cloudflared.source === "cache" && !cloudflared.exists) {
		console.log(cloudflaredNotice);
		await installCloudflared();
	}

	const cfArgs: Record<string, string | number | null> = { "--url": url };
	// Boolean flag: use `null` value so spawn does not pass a stray empty argv (see cloudflared-process).
	if (!opts.verifyTLS) {
		cfArgs["--no-tls-verify"] = null;
	}
	const tunnel = await startCloudflaredTunnelWithRetry(cfArgs);

	const cleanup = async () => {
		tunnel.stop();
	};

	return {
		getURL: async () => await tunnel.url,
		close: cleanup,
	};
}
