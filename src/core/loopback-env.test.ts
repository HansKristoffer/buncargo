import { describe, expect, it } from "bun:test";
import {
	describeStrayLoopbackUrl,
	findStrayLoopbackUrls,
	loopbackUrlPort,
} from "./loopback-env";

describe("loopbackUrlPort", () => {
	it("reads the explicit port of a loopback URL only", () => {
		expect(loopbackUrlPort("http://localhost:8079")).toBe(8079);
		expect(loopbackUrlPort("postgres://u:p@127.0.0.1:5432/db")).toBe(5432);
		expect(loopbackUrlPort("redis://[::1]:6379")).toBe(6379);
		expect(loopbackUrlPort("http://localhost")).toBeUndefined();
		expect(loopbackUrlPort("https://api.example.com:8443")).toBeUndefined();
		expect(loopbackUrlPort("localhost:8079")).toBeUndefined();
	});
});

describe("findStrayLoopbackUrls", () => {
	const ports = { api: 9701, upstash: 8779, postgres: 6132 };

	it("names a shared file's URL to another checkout's port, and the port it meant", () => {
		const stray = findStrayLoopbackUrls({
			sources: [
				{
					source: ".env.local",
					values: { UPSTASH_REDIS_REST_URL: "http://localhost:8079" },
				},
				{
					source: "the injected environment",
					values: {
						UPSTASH_REDIS_REST_URL: "http://localhost:8079",
						API_URL: "http://localhost:9701",
					},
				},
			],
			ports,
			isListening: () => false,
		});
		expect(stray).toEqual([
			{
				key: "UPSTASH_REDIS_REST_URL",
				source: ".env.local",
				url: "http://localhost:8079",
				port: 8079,
				listening: false,
				meant: {
					name: "upstash",
					port: 8779,
					url: "http://localhost:8779",
				},
			},
		]);
		expect(describeStrayLoopbackUrl(stray[0] as (typeof stray)[0])).toContain(
			"buncargo env set UPSTASH_REDIS_REST_URL=http://localhost:8779",
		);
	});

	it("leaves a listening port of no other checkout alone, but not another checkout's", () => {
		const stray = findStrayLoopbackUrls({
			sources: [
				{
					source: ".env",
					values: {
						OLLAMA: "http://localhost:11434",
						UPSTASH_REDIS_REST_URL: "http://localhost:8079",
					},
				},
			],
			ports,
			isListening: () => true,
		});
		expect(stray.map((entry) => entry.key)).toEqual(["UPSTASH_REDIS_REST_URL"]);
		expect(describeStrayLoopbackUrl(stray[0] as (typeof stray)[0])).toContain(
			"8079 is another checkout's upstash, which this checkout would share",
		);
	});

	it("is quiet once buncargo env set overrides the file's value", () => {
		expect(
			findStrayLoopbackUrls({
				sources: [
					{
						source: "buncargo env set",
						values: { UPSTASH_REDIS_REST_URL: "http://localhost:8779" },
					},
					{
						source: ".env.local",
						values: { UPSTASH_REDIS_REST_URL: "http://localhost:8079" },
					},
				],
				ports,
				isListening: () => false,
			}),
		).toEqual([]);
	});
});
