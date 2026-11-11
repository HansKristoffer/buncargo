import { expect, it } from "bun:test";
import { resolveApps, resolveServices } from "../config/resolve";
import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import { type DevArgs, parseDevArgs } from "./dev-flags";

function dev(argv: string[]): DevArgs {
	const parsed = parseDevArgs(argv);
	if (parsed.help) throw new Error("help");
	return parsed;
}

import { CliError } from "./errors";
import { assertConfiguredApps, validateDevStart } from "./validate-dev-start";

const env = {
	root: process.cwd(),
	ports: { web: 3000, api: 3001, db: 5432 },
	apps: resolveApps({
		web: { port: 3000, devCommand: "bun dev", expose: true },
		api: { port: 3001, devCommand: "bun dev", expose: true },
	}),
	services: resolveServices({ db: { port: 5432, expose: true } }),
} as unknown as DevEnvironment<
	Record<string, ServiceConfig>,
	Record<string, AppConfig>
>;

it("rejects missing app working directories before startup", () => {
	expect(() =>
		validateDevStart(
			env,
			dev([]),
			resolveApps({
				web: {
					port: 3000,
					devCommand: "bun dev",
					cwd: "/does-not-exist/buncargo",
				},
			}),
			["db"],
			undefined,
		),
	).toThrow("apps.web.cwd");
});

it("rejects an expose service excluded by the app selection", () => {
	expect(() =>
		validateDevStart(
			env,
			dev(["--apps=web", "--expose=db"]),
			resolveApps({ web: { port: 3000, devCommand: "bun dev", expose: true } }),
			[],
			undefined,
		),
	).toThrow("outside the selected");
});

it("requires the attached app to have a start command", () => {
	expect(() =>
		validateDevStart(
			env,
			dev(["--attach=web"]),
			resolveApps({ web: { port: 3000, devCommand: false } }),
			[],
			undefined,
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
			dev(["--expose=wbe"]),
			resolveApps({ web: { port: 3000, devCommand: "bun dev", expose: true } }),
			[],
			undefined,
		);
	} catch (caught) {
		error = caught;
	}
	expect((error as CliError).hints).toEqual([
		"Not an app or service of this config: wbe",
	]);
});

// Skipping the seed and printing "Seeding complete" told an agent its
// database was seeded when nothing had run.
it("refuses --seed when the selection leaves out the seed's services", () => {
	const seeded = {
		...env,
		apps: resolveApps({
			web: { port: 3000, devCommand: "bun dev" },
			api: { port: 3001, devCommand: "bun dev", requiredServices: ["db"] },
		}),
	};
	const seed = { command: "bun seed", requiredServices: ["db"] };
	let error: unknown;
	try {
		validateDevStart(
			seeded,
			dev(["--seed", "--apps=web"]),
			resolveApps({ web: { port: 3000, devCommand: "bun dev" } }),
			[],
			seed,
		);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(CliError);
	expect((error as CliError).message).toBe(
		"--seed needs db, which this selection does not start.",
	);
	expect((error as CliError).hints).toContain(
		"Or select an app that requires it: --apps=api",
	);
	expect(() =>
		validateDevStart(seeded, dev(["--seed"]), seeded.apps, ["db"], seed),
	).not.toThrow();
});

it("refuses --seed without requiredServices when no service is selected", () => {
	const web = resolveApps({ web: { port: 3000, devCommand: "bun dev" } });
	const seeding = dev(["--seed", "--apps=web"]);
	expect(() =>
		validateDevStart(env, seeding, web, [], { command: "bun seed" }),
	).toThrow("this selection starts none");
	expect(() =>
		validateDevStart(env, seeding, web, [], {
			command: "bun seed",
			requiredServices: [],
		}),
	).not.toThrow();
});
