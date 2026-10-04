import { describe, expect, it } from "bun:test";
import { scratchCommand, scratchUrl, sqlClientCommand } from "./sql";

const credentials = { user: "app", password: "secret", database: "appdb" };

describe("sqlClientCommand", () => {
	it("opens psql with the service's own credentials", () => {
		expect(sqlClientCommand("postgres", credentials, {})).toEqual([
			"env",
			"PGPASSWORD=secret",
			"psql",
			"-X",
			"-U",
			"app",
			"-d",
			"appdb",
		]);
	});

	it("wraps a query as one JSON array of rows", () => {
		const argv = sqlClientCommand("postgres", credentials, {
			query: "select id from users;",
			json: true,
		});
		expect(argv).toContain("-A");
		expect(argv.at(-1)).toBe(
			"select coalesce(json_agg(q), '[]'::json) from (select id from users) q",
		);
		expect(argv).toContain("ON_ERROR_STOP=1");
	});

	it("splits a redis command into words and refuses --json there", () => {
		expect(
			sqlClientCommand("redis", undefined, { query: 'SET k "a b"' }),
		).toEqual(["redis-cli", "SET", "k", "a b"]);
		expect(() =>
			sqlClientCommand("redis", undefined, { query: "GET k", json: true }),
		).toThrow("not supported");
	});

	it("needs a query for --json, and a preset it knows", () => {
		expect(() =>
			sqlClientCommand("postgres", credentials, { json: true }),
		).toThrow("--json needs a query");
		expect(() => sqlClientCommand("mailpit", undefined, {})).toThrow(
			"no client for mailpit",
		);
	});
});

describe("scratch databases", () => {
	it("recreates scratch_<name> in two statements, outside a transaction", () => {
		const argv = scratchCommand(credentials, "migcheck", "create");
		expect(argv.slice(-4)).toEqual([
			"-c",
			"drop database if exists scratch_migcheck with (force)",
			"-c",
			"create database scratch_migcheck",
		]);
		expect(argv).toContain("postgres");
		expect(scratchCommand(credentials, "migcheck", "drop").at(-1)).toBe(
			"drop database if exists scratch_migcheck with (force)",
		);
	});

	it("only takes names that cannot reach another database", () => {
		for (const name of ["app; drop", "App", "", "1x"])
			expect(() => scratchCommand(credentials, name, "drop")).toThrow(
				"Scratch database names",
			);
	});

	it("prints a URL the host can connect to", () => {
		expect(scratchUrl(credentials, 13432, "migcheck")).toBe(
			"postgresql://app:secret@localhost:13432/scratch_migcheck",
		);
	});
});
