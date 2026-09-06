import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "../process/lifecycle";
import {
	parseQuickTunnelUrlFromOutput,
	startCloudflaredTunnel,
} from "./cloudflared-process";

describe("parseQuickTunnelUrlFromOutput", () => {
	it("parses URL from ASCII box pipe line", () => {
		const log = `
2024-01-01T00:00:00Z INF +--------------------------------------------------------------------------------------------+
2024-01-01T00:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable): |
2024-01-01T00:00:00Z INF |  https://foo-bar-baz.trycloudflare.com                                                    |
2024-01-01T00:00:00Z INF +--------------------------------------------------------------------------------------------+
`;
		expect(parseQuickTunnelUrlFromOutput(log)).toBe(
			"https://foo-bar-baz.trycloudflare.com",
		);
	});

	it("parses trycloudflare URL without relying on the pipe prefix", () => {
		const log = `some noise https://x.trycloudflare.com/path more`;
		expect(parseQuickTunnelUrlFromOutput(log)).toBe(
			"https://x.trycloudflare.com",
		);
	});
});

describe("cloudflared process ownership", () => {
	const dirs: string[] = [];
	const tunnels: ReturnType<typeof startCloudflaredTunnel>[] = [];
	afterEach(async () => {
		await Promise.allSettled(tunnels.splice(0).map((tunnel) => tunnel.close()));
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});
	function fixture(output = "") {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-tunnel-child-"));
		dirs.push(dir);
		const path = join(dir, "cloudflared");
		writeFileSync(
			path,
			`#!${process.execPath}\nprocess.on("SIGTERM", () => {});\n${output}\nsetInterval(() => {}, 1000);\n`,
		);
		chmodSync(path, 0o755);
		return path;
	}
	it("terminates a child ignoring TERM before reporting URL timeout", async () => {
		const tunnel = startCloudflaredTunnel(
			{},
			{ binary: fixture(), timeoutMs: 100, graceMs: 60 },
		);
		tunnels.push(tunnel);
		await expect(tunnel.url).rejects.toThrow("timed out");
		expect(tunnel.child.pid && isProcessAlive(tunnel.child.pid)).toBe(false);
	});
	it("cancels URL startup and waits for owned child termination", async () => {
		const controller = new AbortController();
		const tunnel = startCloudflaredTunnel(
			{},
			{ binary: fixture(), signal: controller.signal, graceMs: 60 },
		);
		tunnels.push(tunnel);
		setTimeout(() => controller.abort(new Error("cancelled")), 50);
		await expect(tunnel.url).rejects.toThrow("cancelled");
		expect(tunnel.child.pid && isProcessAlive(tunnel.child.pid)).toBe(false);
	});
	it("closes a ready tunnel idempotently with confirmed exit", async () => {
		const tunnel = startCloudflaredTunnel(
			{},
			{
				binary: fixture('console.log("https://fixture.trycloudflare.com");'),
				graceMs: 60,
			},
		);
		tunnels.push(tunnel);
		expect(await tunnel.url).toBe("https://fixture.trycloudflare.com");
		await Promise.all([tunnel.close(), tunnel.close()]);
		expect(tunnel.child.pid && isProcessAlive(tunnel.child.pid)).toBe(false);
	});
});
