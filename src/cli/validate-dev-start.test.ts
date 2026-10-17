import { expect, it } from "bun:test";
import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import { parseDevArgs } from "./dev-flags";
import { CliError } from "./errors";
import { assertConfiguredApps, validateDevStart } from "./validate-dev-start";

const env = {
	root: process.cwd(),
	ports: { web: 3000, api: 3001, db: 5432 },
	apps: {
		web: { port: 3000, devCommand: "bun dev", expose: true },
		api: { port: 3001, devCommand: "bun dev", expose: true },
	},
	services: { db: { port: 5432, expose: true } },
} as unknown as DevEnvironment<
	Record<string, ServiceConfig>,
	Record<string, AppConfig>
>;

it("rejects missing app working directories before startup", () => {
	expect(() =>
		validateDevStart(
			env,
			parseDevArgs([]),
			{
				web: {
					port: 3000,
					devCommand: "bun dev",
					cwd: "/does-not-exist/buncargo",
				},
			},
			["db"],
		),
	).toThrow("apps.web.cwd");
});

it("rejects an expose service excluded by the app selection", () => {
	expect(() =>
		validateDevStart(
			env,
			parseDevArgs(["--apps=web", "--expose=db"]),
			{ web: { port: 3000, devCommand: "bun dev", expose: true } },
			[],
		),
	).toThrow("outside the selected");
});

it("requires the attached app to have a start command", () => {
	expect(() =>
		validateDevStart(
			env,
			parseDevArgs(["--attach=web"]),
			{ web: { port: 3000, devCommand: false } },
			[],
		),
	).toThrow("not a startable");
});

it("names the configured apps when --apps has a typo", () => {
	let error: unknown;
	try {
		assertConfiguredApps(["api", "web"], ["api", "wbe"]);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(CliError);
	expect((error as CliError).message).toBe("Unknown app in --apps: wbe.");
	expect((error as CliError).hints).toEqual(["Configured apps: api, web"]);
});

it("says why an expose target is invalid", () => {
	let error: unknown;
	try {
		validateDevStart(
			env,
			parseDevArgs(["--expose=wbe"]),
			{ web: { port: 3000, devCommand: "bun dev", expose: true } },
			[],
		);
	} catch (caught) {
		error = caught;
	}
	expect((error as CliError).hints).toEqual([
		"Not an app or service of this config: wbe",
	]);
});
