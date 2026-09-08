import { expect, test } from "bun:test";
import { connectionTokens } from "../runtime-flags";
import { makeSecret } from "./protocol";
import { sharedTargets } from "./targets";

test("environment enables recipient sharing without a flag and rejects malformed values safely", () => {
	const token = `bc1.device.${makeSecret()}`;
	expect(connectionTokens({})).toEqual([]);
	expect(connectionTokens({ BUNCARGO_CONNECT_TOKENS: " [] " })).toEqual([]);
	expect(connectionTokens({ BUNCARGO_CONNECT_TOKENS: token })).toEqual([token]);
	expect(
		connectionTokens({
			BUNCARGO_CONNECT_TOKENS: JSON.stringify([token, token]),
		}),
	).toEqual([token]);
	for (const value of ['["private-secret"]', "[", "{}", "private-secret"]) {
		expect(() => connectionTokens({ BUNCARGO_CONNECT_TOKENS: value })).toThrow(
			"Invalid BUNCARGO_CONNECT_TOKENS",
		);
		try {
			connectionTokens({ BUNCARGO_CONNECT_TOKENS: value });
			throw new Error("Accepted invalid token");
		} catch (error) {
			expect(String(error)).not.toContain(value);
		}
	}
});

test("sharing includes all selected endpoints and infers protocols without expose flags", () => {
	const result = sharedTargets(
		{
			web: { port: 3000, devCommand: "bun web.ts" },
			api: { port: 3001, devCommand: "bun api.ts", expose: false },
			worker: { kind: "worker", devCommand: "bun worker.ts" },
		},
		{
			db: { port: 5432, docker: { kind: "preset", preset: "postgres" } },
			cache: {
				port: 6379,
				expose: false,
				docker: { kind: "preset", preset: "redis" },
			},
			mail: { port: 8025, docker: { kind: "preset", preset: "mailpit" } },
			custom: { port: 4444 },
			http: { port: 8080, exposeProtocol: "http" },
			other: { port: 5555 },
			worker: {},
			job: { kind: "job", rerun: "always" },
		},
		{
			web: 13000,
			api: 13001,
			db: 15432,
			cache: 16379,
			mail: 18025,
			custom: 14444,
			http: 18080,
			other: 15555,
		},
		["db", "cache", "mail", "custom", "http", "worker", "job"],
	);
	expect(result.map((t) => [t.name, t.protocol, t.port])).toEqual([
		["web", "http", 13000],
		["api", "http", 13001],
		["db", "tcp", 15432],
		["cache", "tcp", 16379],
		["mail", "http", 18025],
		["custom", "tcp", 14444],
		["http", "http", 18080],
	]);
	expect(
		sharedTargets(
			{ worker: { kind: "worker", devCommand: "bun worker.ts" } },
			{},
			{},
			[],
		),
	).toEqual([]);
});

test("sharing rejects missing or invalid resolved ports for selected endpoints", () => {
	for (const port of [undefined, 0, -1, 65536, 1.5]) {
		expect(() =>
			sharedTargets(
				{ web: { port: 3000, devCommand: false } },
				{},
				{ web: port as number },
				[],
			),
		).toThrow("Invalid shared target port");
		expect(() =>
			sharedTargets({}, { db: { port: 5432 } }, { db: port as number }, ["db"]),
		).toThrow("Invalid shared target port");
	}
});
