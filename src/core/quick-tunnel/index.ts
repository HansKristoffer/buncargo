/**
 * Cloudflare Quick Tunnel via the cloudflared CLI (same approach as unjs/untun).
 * License / download flow adapted from unjs/untun (MIT).
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { startCloudflaredTunnel } from "./cloudflared-process";
import { cloudflaredBinPath, cloudflaredNotice } from "./constants";
import { installCloudflared } from "./install";

export interface QuickTunnelOptions {
	url?: string;
	port?: number | string;
	hostname?: string;
	protocol?: "http" | "https";
	verifyTLS?: boolean;
	acceptCloudflareNotice?: boolean;
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

function envAcceptsCloudflareNotice(): boolean {
	const v = process.env.BUNCARGO_ACCEPT_CLOUDFLARE_NOTICE;
	const u = process.env.UNTUN_ACCEPT_CLOUDFLARE_NOTICE;
	return v === "1" || v === "true" || u === "1" || u === "true";
}

async function promptInstallCloudflared(): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return false;
	}
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(
			"Do you agree with the above terms and wish to install the binary from GitHub? (y/N) ",
			(answer) => {
				rl.close();
				resolve(/^y(es)?$/i.test(answer.trim()));
			},
		);
	});
}

/**
 * Start a Cloudflare quick tunnel to a local HTTP(S) URL.
 * Returns undefined if the user declines the cloudflared install (when binary is missing).
 */
export async function startQuickTunnel(
	opts: QuickTunnelOptions,
): Promise<QuickTunnel | undefined> {
	const url = resolvedLocalUrl(opts);

	console.log(`Starting cloudflared tunnel to ${url}`);

	if (!existsSync(cloudflaredBinPath)) {
		console.log(cloudflaredNotice);
		const canInstall =
			opts.acceptCloudflareNotice ||
			envAcceptsCloudflareNotice() ||
			(await promptInstallCloudflared());
		if (!canInstall) {
			console.error("Skipping tunnel setup.");
			return;
		}
		await installCloudflared();
	}

	const cfArgs: Record<string, string | number | null> = { "--url": url };
	// Boolean flag: use `null` value so spawn does not pass a stray empty argv (see cloudflared-process).
	if (!opts.verifyTLS) {
		cfArgs["--no-tls-verify"] = null;
	}
	const tunnel = startCloudflaredTunnel(cfArgs);

	const cleanup = async () => {
		tunnel.stop();
	};

	return {
		getURL: async () => await tunnel.url,
		close: cleanup,
	};
}
