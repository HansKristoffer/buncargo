import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import worker from "./worker";

const config = JSON.parse(
	readFileSync(
		new URL("../../wrangler.connect.jsonc", import.meta.url),
		"utf8",
	),
);
function fixture() {
	const counts = new Map<string, number>();
	let forwarded = 0;
	const quota = (name: string) => ({
		async limit({ key }: { key: string }) {
			const bucket = `${name}:${key}`;
			const count = (counts.get(bucket) ?? 0) + 1;
			counts.set(bucket, count);
			const limit =
				config.ratelimits.find((item: { name: string }) => item.name === name)
					?.simple.limit ?? 0;
			return { success: count <= limit };
		},
	});
	const env = {
		CONNECT_ORIGIN: "https://connect.example.com",
		CONNECT_SIGNING_JWK: "{}",
		RATE_LIMITER: quota("RATE_LIMITER"),
		SESSION_RATE_LIMITER: quota("SESSION_RATE_LIMITER"),
		RECIPIENTS: {
			idFromName: (name: string) => name,
			get: () => ({
				fetch: async () => {
					forwarded++;
					return new Response("Recipient authentication still required", {
						status: 403,
					});
				},
			}),
		},
	};
	const request = (suffix: string, method = "GET", upgrade = false) =>
		new Request(
			`${env.CONNECT_ORIGIN}/v1/devices/device/sessions/session${suffix}`,
			{
				method,
				headers: {
					"cf-connecting-ip": "192.0.2.1",
					...(upgrade ? { upgrade: "websocket" } : {}),
				},
			},
		);
	return { env, request, counts, forwarded: () => forwarded };
}

test("a large module graph does not exhaust the session or directory request budget", async () => {
	const f = fixture();
	// A page with 1,400 modules: an access request and both relay handshakes
	// per module, even when publisher and browser share one egress IP.
	for (let i = 0; i < 1400; i++) {
		for (const request of [
			f.request("/access", "POST"),
			f.request("/relay/stream/web", "GET", true),
			f.request("/relay/pipe/stream-id", "GET", true),
		]) {
			expect((await worker.fetch(request, f.env)).status).toBe(403);
		}
	}
	expect(f.forwarded()).toBe(4200);
	expect(f.counts.get("RATE_LIMITER:192.0.2.1")).toBeUndefined();
	expect((await worker.fetch(f.request("", "PUT"), f.env)).status).toBe(403);
});

test.each([
	["/access", "GET", false],
	["/relay/stream/web", "GET", false],
	["/relay/stream/web/extra", "GET", true],
	["", "PUT", false],
	["", "DELETE", false],
] as const)(
	"other operations retain the directory limit: %s %s",
	async (path, method, upgrade) => {
		const f = fixture();
		f.env.RATE_LIMITER.limit = async () => ({ success: false });
		expect(
			(await worker.fetch(f.request(path, method, upgrade), f.env)).status,
		).toBe(429);
		expect(f.forwarded()).toBe(0);
	},
);

test("session requests remain rate limited before recipient authentication", async () => {
	const f = fixture();
	f.env.SESSION_RATE_LIMITER.limit = async () => ({ success: false });
	for (const request of [
		f.request("/access", "POST"),
		f.request("/relay/publisher", "GET", true),
	]) {
		expect((await worker.fetch(request, f.env)).status).toBe(429);
	}
	expect(f.forwarded()).toBe(0);
});
