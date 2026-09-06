import { expect, it } from "bun:test";
import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import { parseDevArgs } from "./dev-flags";
import { validateDevStart } from "./validate-dev-start";

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
