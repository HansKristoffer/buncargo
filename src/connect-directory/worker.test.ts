import { expect, test } from "bun:test";
import worker, { RecipientDirectory } from "./worker";

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
