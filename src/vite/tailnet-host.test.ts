import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { coordinatorStatePath } from "../core/tailnet/coordinator-state";
import { createTailnetHostAccess } from "./tailnet-host";

const ownHost = "publisher.tail123.ts.net";
const foreignHost = "other.tail123.ts.net";

/** A real Vite 8 server: it freezes host validation before configureServer. */
async function fixture(resolveHostname: () => Promise<string | undefined>) {
	const root = await mkdtemp(join(tmpdir(), "buncargo-vite-host-"));
	await writeFile(join(root, "index.html"), "<h1>Host validation fixture</h1>");
	const access = createTailnetHostAccess(resolveHostname);
	const server = await createServer({
		root,
		configFile: false,
		logLevel: "silent",
		optimizeDeps: { noDiscovery: true },
		plugins: [
			{
				name: "tailnet-host-test",
				async config() {
					return { server: { allowedHosts: await access.allowedHosts() } };
				},
				configureServer: (server) => access.watch(server),
			},
		],
		server: { host: "127.0.0.1", port: 0, allowedHosts: ["project.localhost"] },
	});
	await server.listen();
	return {
		server,
		request(host: string) {
			const address = server.httpServer?.address();
			if (!address || typeof address === "string")
				throw new Error("No listener");
			return new Promise<number>((resolve, reject) => {
				get(
					{
						hostname: "127.0.0.1",
						port: address.port,
						headers: { Host: host },
					},
					(res) => {
						res.resume();
						res.on("end", () => resolve(res.statusCode ?? 0));
					},
				).on("error", reject);
			});
		},
		async [Symbol.asyncDispose]() {
			await server.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

describe("Vite Tailscale host checks", () => {
	it("allows the local node before host checks are frozen and preserves configured hosts", async () => {
		let calls = 0;
		await using app = await fixture(async () => {
			calls++;
			return ownHost;
		});
		expect(await app.request(ownHost)).toBe(200);
		expect(await app.request("project.localhost")).toBe(200);
		expect(await app.request(foreignHost)).toBe(403);
		expect(await app.request("attacker.example")).toBe(403);
		expect(calls).toBe(1);
	});

	it("does not probe Tailscale for parallel module requests", async () => {
		let calls = 0;
		await using app = await fixture(async () => {
			calls++;
			return ownHost;
		});
		expect(
			await Promise.all(Array.from({ length: 20 }, () => app.request(ownHost))),
		).toEqual(Array(20).fill(200));
		expect(calls).toBe(1);
	});

	it("fails closed and reloads config after cloud enrollment without an app restart", async () => {
		let connected = false;
		let calls = 0;
		await using app = await fixture(async () => {
			calls++;
			if (!connected) throw new Error("Tailscale unavailable");
			return ownHost;
		});
		expect(await app.request(ownHost)).toBe(403);
		expect(await app.request("project.localhost")).toBe(200);
		connected = true;
		app.server.watcher.emit("change", coordinatorStatePath());
		const deadline = Date.now() + 5000;
		let status = 0;
		while (Date.now() < deadline) {
			try {
				status = await app.request(ownHost);
			} catch {
				/* Vite is restarting. */
			}
			if (status === 200) break;
			await Bun.sleep(20);
		}
		expect(status).toBe(200);
		expect(await app.request(foreignHost)).toBe(403);
		const after = calls;
		app.server.watcher.emit("change", coordinatorStatePath());
		await Bun.sleep(20);
		expect(calls).toBe(after);
	});
});
