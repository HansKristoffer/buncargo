import { describe, expect, it } from "bun:test";
import { ensurePubsubTopics } from "./pubsub";

describe("ensurePubsubTopics", () => {
	it("creates deduplicated topics via PUT and accepts 200, 201 and 409 idempotently", async () => {
		const calls: { url: string; method: string }[] = [];
		const responses = [200, 409];
		const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
			calls.push({ url: String(input), method: init?.method ?? "GET" });
			return new Response("{}", { status: responses.shift() ?? 200 });
		}) as unknown as typeof fetch;

		await ensurePubsubTopics({
			host: "127.0.0.1",
			port: 8085,
			projectId: "demo-kanpla",
			topics: ["orders-created", "emails-send", "orders-created"],
			fetchImpl: fakeFetch,
		});

		expect(calls).toEqual([
			{
				url: "http://127.0.0.1:8085/v1/projects/demo-kanpla/topics/orders-created",
				method: "PUT",
			},
			{
				url: "http://127.0.0.1:8085/v1/projects/demo-kanpla/topics/emails-send",
				method: "PUT",
			},
		]);
	});

	it("brackets IPv6 emulator hosts cleanly", async () => {
		const urls: string[] = [];
		const fakeFetch = (async (input: string | URL) => {
			urls.push(String(input));
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;

		await ensurePubsubTopics({
			host: "::1",
			port: 8085,
			projectId: "demo-kanpla",
			topics: ["orders-created"],
			fetchImpl: fakeFetch,
		});

		expect(urls).toEqual([
			"http://[::1]:8085/v1/projects/demo-kanpla/topics/orders-created",
		]);
	});

	it("throws an actionable error when the emulator rejects a topic", async () => {
		const fakeFetch = (async () =>
			new Response("internal error", {
				status: 500,
			})) as unknown as typeof fetch;

		await expect(
			ensurePubsubTopics({
				host: "127.0.0.1",
				port: 8085,
				projectId: "demo-kanpla",
				topics: ["bad-topic"],
				fetchImpl: fakeFetch,
			}),
		).rejects.toThrow(
			'Pub/Sub emulator rejected topic "bad-topic" with HTTP 500: internal error',
		);
	});
});
