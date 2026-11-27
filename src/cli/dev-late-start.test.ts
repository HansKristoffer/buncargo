import { expect, it } from "bun:test";
import { resolveApps, resolveServices } from "../config/resolve";
import { RunOutput } from "../core/process/run-output";
import type { ResolvedApp } from "../types";
import {
	bindLateStarts,
	type LateStartRun,
	leftOutApps,
	leftOutNotice,
	planLateStart,
	startLeftOutApp,
} from "./dev-late-start";
import { cliLeasePolicy } from "./dev-leases";

const apps = resolveApps({
	api: { port: 3000, devCommand: "bun api.ts", requiredServices: ["postgres"] },
	web: { port: 3001, devCommand: "bun web.ts", requiredApps: ["api"] },
	mobile: {
		port: 8081,
		devCommand: "bunx expo start",
		requiredApps: ["api", "metroProxy"],
	},
	metroProxy: { port: 8082, devCommand: "bun proxy.ts" },
	search: {
		port: 3002,
		devCommand: "bun search.ts",
		requiredServices: ["redis"],
	},
	docs: { port: 3003, devCommand: false },
});
const services = resolveServices({
	postgres: { port: 5432 },
	redis: { port: 6379 },
});

/** A run of `web` and `api` on postgres, recording what it was asked to start. */
function run(
	start: LateStartRun["start"] = async (toStart) => ({
		status: "started",
		apps: Object.keys(toStart),
	}),
	preflight: LateStartRun["preflight"] = async () => {},
): LateStartRun & {
	asked: Record<string, ResolvedApp>[];
	inRun: Set<string>;
} {
	const asked: Record<string, ResolvedApp>[] = [];
	const inRun = new Set(["web", "api"]);
	return {
		apps,
		services,
		runServices: new Set(["postgres"]),
		running: () => [...inRun],
		preflight,
		start: (toStart, options) => {
			asked.push(toStart);
			return start(toStart, options);
		},
		inRun,
		leasePolicy: cliLeasePolicy({
			takeover: () => ({ kind: "none" }),
			interactive: false,
		}),
		asked,
	};
}

it("offers every app with a dev command the run left out", () => {
	expect(leftOutApps(apps, new Set(["web", "api"]))).toEqual([
		"mobile",
		"metroProxy",
		"search",
	]);
});

it("starts the app with the required apps the run has not started, all spared", async () => {
	const late = run();
	expect(await startLeftOutApp(late, "mobile")).toEqual({
		status: "started",
		apps: ["metroProxy", "mobile"],
	});

	const [asked] = late.asked;
	expect(Object.keys(asked ?? {})).toEqual(["metroProxy", "mobile"]);
	expect(asked?.mobile?.essential).toBe(false);
	expect(asked?.metroProxy?.essential).toBe(false);
});

it("refuses an app that needs a service the run did not start, naming the start that has it", async () => {
	const late = run();
	expect(await startLeftOutApp(late, "search")).toEqual({
		status: "refused",
		reason:
			"search needs redis, which this run did not start. End the run and start it with them: buncargo dev --apps=web,api,search",
	});
	expect(late.asked).toEqual([]);
});

it("refuses what it cannot start without asking the run", async () => {
	const late = run();
	expect(await startLeftOutApp(late, "docs")).toMatchObject({
		status: "refused",
	});
	expect(await startLeftOutApp(late, "nope")).toMatchObject({
		status: "refused",
	});
	expect(await startLeftOutApp(late, "web")).toEqual({
		status: "refused",
		reason: "web is already part of this run",
	});
	expect(late.asked).toEqual([]);
});

it("says who holds the lease when another run holds it", async () => {
	const late = run(async () => ({
		status: "refused",
		skipped: {
			app: "mobile",
			key: "expo-dev-client",
			holder: {
				key: "expo-dev-client",
				sessionId: "other",
				pid: 4242,
				app: "mobile",
				projectName: "shop",
				root: "/work/shop-feature",
				worktree: "shop-feature",
				acquiredAt: new Date().toISOString(),
			},
		},
	}));

	const reply = await startLeftOutApp(late, "mobile");
	expect(reply.status).toBe("refused");
	const lines = reply.status === "refused" ? reply.reason.split("\n") : [];
	expect(lines[0]).toBe(
		"mobile cannot start: expo-dev-client is in use by another run.",
	);
	expect(lines).toContain("Checkout: /work/shop-feature");
});

it("refuses an app whose preflight cannot pass without a terminal", async () => {
	const late = run(undefined, async (names) => {
		expect(names).toEqual(["metroProxy", "mobile"]);
		throw new Error("Expo login: run `bunx expo login`");
	});
	expect(await startLeftOutApp(late, "mobile")).toEqual({
		status: "refused",
		reason: "Expo login: run `bunx expo login`",
	});
	expect(late.asked).toEqual([]);
});

// Two `r` presses while the first start was still claiming both claimed it.
it("starts one request at a time, so a second finds the app already part of the run", async () => {
	const claimed = Promise.withResolvers<void>();
	const late = run(async (toStart) => {
		await claimed.promise;
		for (const name of Object.keys(toStart)) late.inRun.add(name);
		return { status: "started", apps: Object.keys(toStart) };
	});
	const output = new RunOutput({ terminals: "pipe" });
	bindLateStarts(output, late);

	const first = output.startApp?.("mobile");
	const second = output.startApp?.("mobile");
	claimed.resolve();

	expect(await first).toEqual({
		status: "started",
		apps: ["metroProxy", "mobile"],
	});
	expect(await second).toEqual({
		status: "refused",
		reason: "mobile is already part of this run",
	});
	expect(late.asked).toHaveLength(1);
});

it("says once, when it binds, what the run left out and how to start it", () => {
	const output = new RunOutput({ terminals: "pipe" });
	const said: string[] = [];
	output.subscribe({ line: (line) => said.push(line.text) });
	bindLateStarts(output, run());

	expect(said).toEqual([
		"Not started: mobile, metroProxy, search (needs redis). Start one in this run with r on it, or `buncargo restart <app>`.",
	]);
});

it("plans a late start: the apps it brings that the run lacks, and the services it lacks", () => {
	const config = { apps, services };
	expect(
		planLateStart(
			config,
			{ running: new Set(["api"]), services: new Set(["postgres"]) },
			"mobile",
		),
	).toEqual({
		apps: { metroProxy: apps.metroProxy, mobile: apps.mobile },
		missingServices: [],
	});
	expect(
		planLateStart(config, { running: new Set(), services: new Set() }, "web")
			.missingServices,
	).toEqual(["postgres"]);
	expect(leftOutNotice({ ...run(), apps: { web: apps.web } })).toBeUndefined();
});
