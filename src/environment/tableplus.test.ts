import { describe, expect, it } from "bun:test";
import { tablePlusUrl } from "./tableplus";

describe("tablePlusUrl", () => {
	it("builds a TablePlus connection URL, not a table-filter deeplink", () => {
		const url = tablePlusUrl({
			user: "postgres",
			password: "postgres",
			port: 13233,
			database: "playground",
			name: "buncargo-playground-playground-postgres",
		});
		expect(url).toBe(
			"postgresql://postgres:postgres@127.0.0.1:13233/playground?env=development&name=buncargo-playground-playground-postgres&tLSMode=0",
		);
		expect(url).not.toContain("schema=");
	});

	it("percent-encodes credentials and the connection name", () => {
		const url = tablePlusUrl({
			user: "u@ser",
			password: "p@ss:word",
			port: 5432,
			database: "app db",
			name: "My DB",
		});
		expect(url).toBe(
			"postgresql://u%40ser:p%40ss%3Aword@127.0.0.1:5432/app%20db?env=development&name=My%20DB&tLSMode=0",
		);
	});
});
