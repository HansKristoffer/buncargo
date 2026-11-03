import { describe, expect, it } from "bun:test";
import { planJsonQuery, unwrapJsonErrors } from "./sql-statements";

describe("planJsonQuery", () => {
	it("wraps one SELECT or WITH, with the user's text on lines of its own", () => {
		expect(planJsonQuery("select id from users; ")).toEqual({
			wrap: true,
			statement:
				"select coalesce(json_agg(_buncargo_rows.*), '[]'::json) from (\nselect id from users\n) _buncargo_rows",
		});
		const withQuery = planJsonQuery(
			"WITH t AS (select 1 as q) SELECT q FROM t -- the q column",
		);
		expect(withQuery.wrap).toBe(true);
		// A trailing comment cannot swallow the closing parenthesis.
		if (withQuery.wrap)
			expect(withQuery.statement).toEndWith(
				"-- the q column\n) _buncargo_rows",
			);
	});

	it("runs anything else plain", () => {
		expect(planJsonQuery("update users set name = 'x'")).toEqual({
			wrap: false,
			reason: "is not a SELECT or WITH, or changes data",
		});
		expect(planJsonQuery("select 1; select 2;")).toEqual({
			wrap: false,
			reason: "has more than one statement",
		});
		for (const sql of [
			"with moved as (delete from a returning *) select * from moved",
			"select * into copy_of_users from users",
			"select * from jobs for update skip locked",
			"explain select 1",
			"select 1 \\gx",
			"select 'unterminated",
			"select 1 /* open",
		])
			expect(planJsonQuery(sql).wrap).toBe(false);
	});

	it("does not split on semicolons inside strings, identifiers or comments", () => {
		for (const sql of [
			"select ';' as semi",
			"select 'it''s; fine'",
			"select E'a\\'; b'",
			'select 1 as "a;b"',
			"select $$ ; $$ as body",
			"select $fn$ ; update $fn$",
			"select 1 -- ; update\n",
			"select /* ; /* nested ; */ update */ 1",
			"select $1::int",
		])
			expect(planJsonQuery(sql).wrap).toBe(true);
	});

	it("ignores words that only look like keywords", () => {
		expect(planJsonQuery("select updated_at, 'update' from t").wrap).toBe(true);
	});
});

describe("unwrapJsonErrors", () => {
	it("numbers error lines as the user wrote them", () => {
		expect(
			unwrapJsonErrors(
				'ERROR:  column "nope" does not exist\nLINE 2: select nope from users\n               ^\n',
			),
		).toBe(
			'ERROR:  column "nope" does not exist\nLINE 1: select nope from users\n               ^\n',
		);
	});

	it("keeps the caret under the error when the number loses a digit", () => {
		expect(unwrapJsonErrors("LINE 10: from nope\n               ^")).toBe(
			"LINE 9: from nope\n              ^",
		);
	});
});
