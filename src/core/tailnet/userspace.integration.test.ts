import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailscaleTestsEnabled } from "../runtime-flags";
import { installTailscale, TAILSCALE_VERSION } from "./binary";
import { startGuardedChild } from "./child-guard";
import { createTailscaleClient } from "./client";
import { listenEndpoint, serveTarget } from "./endpoint";

async function setServeConfig(socketPath: string, config: unknown) {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = request(
			{
				socketPath,
				path: "/localapi/v0/serve-config",
				method: "POST",
				headers: {
					Host: "local-tailscaled.sock",
					"Content-Type": "application/json",
				},
			},
			(res) => {
				let body = "";
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.end(JSON.stringify(config));
	});
}

test.skipIf(!tailscaleTestsEnabled() || process.platform !== "linux")(
	"official verified binaries start without TUN, root networking or a login",
	async () => {
		const { binary, daemon } = await installTailscale();
		const directory = await mkdtemp(join(tmpdir(), "bc-real-ts-")),
			socket = join(directory, "tailscaled.sock");
		const child = startGuardedChild(
			daemon,
			["--tun=userspace-networking", "--state=mem:", `--socket=${socket}`],
			directory,
		);
		const command = createTailscaleClient(binary, socket);
		try {
			expect(await command(["version"])).toContain(TAILSCALE_VERSION);
			let status: { BackendState?: string } | undefined;
			for (let i = 0; i < 100; i++) {
				try {
					status = JSON.parse(await command(["status", "--json"]));
					break;
				} catch {
					await Bun.sleep(100);
				}
			}
			expect(status?.BackendState).toBe("NeedsLogin");
			if (process.getuid?.() !== 0) {
				const server = createServer();
				try {
					const endpoint = await listenEndpoint(server);
					const httpConfig = (target: string) => ({
						TCP: { 48443: { HTTPS: true } },
						Web: {
							"test.tail123.ts.net:48443": {
								Handlers: { "/": { Proxy: target } },
							},
						},
					});
					// Reproduce the old Linux failure without an enrollment key.
					const denied = await setServeConfig(
						socket,
						httpConfig("unix:/tmp/app.sock"),
					);
					expect(denied.status).toBe(401);
					expect(denied.body).toContain("must be root");
					for (const config of [
						httpConfig(serveTarget(endpoint, "http")),
						{ TCP: { 24444: { TCPForward: serveTarget(endpoint, "tcp") } } },
					]) {
						const result = await setServeConfig(socket, config);
						// Passing authorization reaches the backend. This deliberately
						// unauthenticated daemon cannot install routes without a netmap.
						expect(result.status).toBe(500);
						expect(result.body).toContain("netMap is nil");
					}
				} finally {
					server.close();
				}
			}
		} finally {
			await child.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
	180000,
);
