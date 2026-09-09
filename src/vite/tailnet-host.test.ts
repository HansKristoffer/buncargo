import { describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import { allowTailnetHost, type ViteHostServer } from "./tailnet-host";

const ownHost = "publisher.tail123.ts.net";
const foreignHost = "other.tail123.ts.net";

/** Exercise middleware ordering: the following handler represents Vite's host check. */
async function fixture(
	resolveHostname: () => Promise<string | undefined>,
	allowedHosts: string[] | true = ["project.localhost"],
) {
	let middleware: Parameters<ViteHostServer["middlewares"]["use"]>[0];
	allowTailnetHost(
		{
			config: { server: { allowedHosts } },
			middlewares: {
				use: (handler) => {
					middleware = handler;
				},
			},
		},
		resolveHostname,
	);
	const server = createServer((req, res) => {
		middleware(req, res, () => {
			const host = req.headers.host?.split(":")[0]?.toLowerCase() ?? "";
			res.writeHead(
				allowedHosts === true || allowedHosts.includes(host) ? 200 : 403,
			);
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No listener");
	return {
		allowedHosts,
		async request(host: string) {
			const response = await fetch(`http://127.0.0.1:${address.port}/`, {
				headers: { host },
			});
			await response.arrayBuffer();
			return response.status;
		},
		async [Symbol.asyncDispose]() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

describe("Vite Tailscale host checks", () => {
	it("allows only the local node and preserves configured hosts", async () => {
		let calls = 0;
		await using app = await fixture(async () => {
			calls++;
			return ownHost;
		});
		expect(await app.request("project.localhost")).toBe(200);
		expect(calls).toBe(0);
		expect(await app.request(`${ownHost.toUpperCase()}:23456`)).toBe(200);
		expect(await app.request(foreignHost)).toBe(403);
		expect(await app.request("attacker.example")).toBe(403);
		expect(app.allowedHosts).toEqual(["project.localhost", ownHost]);
		expect(calls).toBe(1);
	});

	it("shares a lookup across parallel requests without duplicate hosts", async () => {
		let calls = 0;
		await using app = await fixture(async () => {
			calls++;
			await Bun.sleep(25);
			return ownHost;
		});
		expect(
			await Promise.all(Array.from({ length: 20 }, () => app.request(ownHost))),
		).toEqual(Array(20).fill(200));
		expect(calls).toBe(1);
		expect(app.allowedHosts).toEqual(["project.localhost", ownHost]);
	});

	it("fails closed and recovers when enrollment finishes after startup", async () => {
		let connected = false;
		await using app = await fixture(async () => {
			if (!connected) throw new Error("Tailscale unavailable");
			return ownHost;
		});
		expect(await app.request(ownHost)).toBe(403);
		expect(await app.request("project.localhost")).toBe(200);
		connected = true;
		await Bun.sleep(2100);
		expect(await app.request(ownHost)).toBe(200);
	});

	it("respects an explicit disabled host check without probing Tailscale", async () => {
		await using app = await fixture(async () => {
			throw new Error("Must not run");
		}, true);
		expect(await app.request(ownHost)).toBe(200);
	});
});
