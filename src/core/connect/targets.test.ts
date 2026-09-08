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

test("sharing intersects selection and expose, and infers protocol from presets", () => {
	const result = sharedTargets(
		{
			web: { port: 3000, devCommand: "bun web.ts", expose: true },
			internal: { port: 3001, devCommand: "bun internal.ts" },
		},
		{
			db: {
				port: 5432,
				expose: true,
				docker: { kind: "preset", preset: "postgres" },
			},
			cache: {
				port: 6379,
				expose: true,
				docker: { kind: "preset", preset: "redis" },
			},
			other: { port: 4444, expose: true, exposeProtocol: "tcp" },
		},
		{ web: 3000, internal: 3001, db: 5432, cache: 6379, other: 4444 },
		["db", "cache"],
	);
	expect(result.map((t) => [t.name, t.protocol])).toEqual([
		["web", "http"],
		["db", "tcp"],
		["cache", "tcp"],
	]);
	expect(() =>
		sharedTargets({}, { custom: { port: 42, expose: true } }, { custom: 42 }, [
			"custom",
		]),
	).toThrow("exposeProtocol");
});
