/**
 * Real cloudflared quick tunnel (same file as this module). Requires network; may download
 * cloudflared on first run when `acceptCloudflareNotice` is true.
 *
 * Smoke runs with every `bun test`. E2E (curl through the public URL) is opt-in — set
 * `BUNCARGO_TEST_CLOUDFLARED_E2E=1` — because `*.trycloudflare.com` resolution and routing are
 * flaky on some networks and in sandboxes (Bun `fetch` is unreliable there too, hence curl).
 */

import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sleep } from "../utils";
import { startQuickTunnel } from "./index";

const execFileAsync = promisify(execFile);

const runE2eThroughTunnel =
	process.env.BUNCARGO_TEST_CLOUDFLARED_E2E === "1" ||
	process.env.BUNCARGO_TEST_CLOUDFLARED_E2E === "true";

async function curlPublicUrlWhenReady(publicUrl: string): Promise<string> {
	const maxAttempts = 15;
	const delayMs = 2000;
	let lastError: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			const { stdout } = await execFileAsync("curl", [
				"-fsSL",
				"--connect-timeout",
				"5",
				"--max-time",
				"12",
				"--retry",
				"0",
				publicUrl,
			]);
			return String(stdout);
		} catch (e) {
			lastError = e;
		}
		await sleep(delayMs);
	}
	throw new Error(
		`Tunnel URL not reachable after ${maxAttempts} attempts. Last error: ${String(lastError)}`,
	);
}

async function startLocalServerAndTunnel(): Promise<{
	server: ReturnType<typeof Bun.serve>;
	localUrl: string;
	tunnel: NonNullable<Awaited<ReturnType<typeof startQuickTunnel>>>;
	publicUrl: string;
}> {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return new Response("ok", { status: 200 });
		},
	});
	const port = server.port;
	const localUrl = `http://127.0.0.1:${port}`;
	const localCheck = await fetch(localUrl);
	expect(localCheck.ok).toBe(true);

	const tunnel = await startQuickTunnel({
		url: localUrl,
		acceptCloudflareNotice: true,
	});

	if (tunnel === undefined) {
		throw new Error(
			"startQuickTunnel returned undefined (cloudflared missing or install declined)",
		);
	}

	const publicUrl = await tunnel.getURL();
	expect(publicUrl).toMatch(/^https:\/\//);
	expect(publicUrl).toMatch(/cloudflare/i);

	return { server, localUrl, tunnel, publicUrl };
}

describe("startQuickTunnel (real cloudflared)", () => {
	it(
		"returns a public https URL (smoke — no request through tunnel)",
		async () => {
			let server: ReturnType<typeof Bun.serve> | undefined;
			try {
				const ctx = await startLocalServerAndTunnel();
				server = ctx.server;
				await ctx.tunnel.close();
			} finally {
				server?.stop();
			}
		},
		{ timeout: 180_000 },
	);

	it.skipIf(!runE2eThroughTunnel)(
		"routes HTTPS traffic to Bun.serve (e2e)",
		async () => {
			let server: ReturnType<typeof Bun.serve> | undefined;
			try {
				const ctx = await startLocalServerAndTunnel();
				server = ctx.server;
				await sleep(1500);
				const body = (await curlPublicUrlWhenReady(ctx.publicUrl)).trim();
				expect(body).toBe("ok");
				await ctx.tunnel.close();
			} finally {
				server?.stop();
			}
		},
		{ timeout: 240_000 },
	);
});
