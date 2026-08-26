import { describe, expect, it } from "bun:test";
import { parseComposePs, readComposeState } from "./diagnose";

describe("parseComposePs", () => {
	it("reads the JSON array form", () => {
		expect(parseComposePs('[{"Service":"postgres","State":"exited"}]')).toEqual(
			[{ Service: "postgres", State: "exited" }],
		);
	});

	it("reads the line-delimited form compose also emits", () => {
		expect(
			parseComposePs(
				'{"Service":"postgres","State":"running"}\n{"Service":"redis","State":"exited"}',
			),
		).toEqual([
			{ Service: "postgres", State: "running" },
			{ Service: "redis", State: "exited" },
		]);
	});

	it("returns nothing for empty or unparseable output", () => {
		expect(parseComposePs("")).toEqual([]);
		expect(parseComposePs("   ")).toEqual([]);
		expect(parseComposePs("not json")).toEqual([]);
	});

	it("skips a partial line rather than losing the whole read", () => {
		expect(
			parseComposePs('{"Service":"postgres","State":"running"}\n{"Serv'),
		).toEqual([{ Service: "postgres", State: "running" }]);
	});
});

describe("readComposeState", () => {
	it("prefers State and carries the exit code", () => {
		expect(readComposeState({ State: "exited", ExitCode: 1 })).toEqual({
			state: "exited",
			exitCode: 1,
		});
	});

	it("falls back to Status when State is absent", () => {
		expect(readComposeState({ Status: "running" })).toEqual({
			state: "running",
			exitCode: undefined,
		});
	});

	it("reports unknown rather than throwing on an unfamiliar shape", () => {
		expect(readComposeState({}).state).toBe("unknown");
	});
});
