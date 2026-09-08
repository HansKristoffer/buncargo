import { expect, test } from "bun:test";
import { tailcatDerpMap } from "../core/runtime-flags";
import worker, { RecipientDirectory } from "./worker";

test("default relay map is public and independent of discovery quota and recipient storage", async () => {
	const unexpected = () => {
		throw new Error("Static relay metadata must not access recipient state");
	};
	const env = {
		CONNECT_ORIGIN: "https://connect.hanskristoffer.dk",
		RATE_LIMITER: { limit: unexpected },
		RECIPIENTS: { idFromName: unexpected, get: unexpected },
	};
	const response = await worker.fetch(new Request(tailcatDerpMap({})), env);
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("public, max-age=300");
	const map = await response.json();
	expect(Object.keys(map)).toEqual(["Regions"]);
	expect(Object.keys(map.Regions)).toEqual(["900"]);
	expect(map.Regions[900]).toMatchObject({
		RegionID: 900,
		Nodes: [
			{
				Name: "900a",
				RegionID: 900,
				HostName: "derp.hanskristoffer.dk",
				IPv4: "178.104.193.175",
				DERPPort: 443,
				STUNPort: 3478,
			},
		],
	});
	const post = await worker.fetch(
		new Request(tailcatDerpMap({}), { method: "POST" }),
		env,
	);
	expect(post.status).toBe(405);
	expect(post.headers.get("allow")).toBe("GET");
});

test("Worker serves discovery and rejects the removed relay and signing-key endpoints", async () => {
	const values = new Map<string, unknown>();
	const env = {
		CONNECT_ORIGIN: "https://connect.example",
		RATE_LIMITER: { limit: async () => ({ success: true }) },
		RECIPIENTS: { idFromName: (name: string) => name, get: () => directory },
	};
	const directory = new RecipientDirectory(
		{
			storage: {
				get: async <T>(key: string) => values.get(key) as T,
				put: async (key, value) => {
					values.set(key, value);
				},
			},
		},
		env,
	);
	expect(
		(await worker.fetch(new Request("https://connect.example/health"), env))
			.status,
	).toBe(200);
	expect(
		(await worker.fetch(new Request("https://connect.example/v1/key"), env))
			.status,
	).toBe(404);
	expect(
		(
			await worker.fetch(
				new Request(
					"https://connect.example/v1/devices/d/sessions/s/relay/publisher",
					{ headers: { upgrade: "websocket" } },
				),
				env,
			)
		).status,
	).not.toBe(101);
	expect(
		(
			await worker.fetch(
				new Request("https://connect.example/v1/devices/d/sessions"),
				{ ...env, RATE_LIMITER: { limit: async () => ({ success: false }) } },
			)
		).status,
	).toBe(429);
});
