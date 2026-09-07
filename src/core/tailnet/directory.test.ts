import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { RunEntry } from "../run-registry";
import { directorySnapshot } from "./directory";
import { readLimitedBody } from "./peers";
import { parseRemoteDirectory, type RemoteDirectory } from "./protocol";
import type { TailnetState } from "./state";

it("emits the same v1 fixture decoded by the Swift smoke test", () => {
	const hostname = "devbox.tail123.ts.net";
	const root = "/private/checkout";
	const apps = [
		{ name: "platform", port: 25173 },
		{ name: "api", port: 23000 },
	];
	const state: TailnetState = {
		version: 1,
		enabled: true,
		allocations: apps.map((a) => ({
			key: a.name,
			port: a.port,
			lease: {
				pid: 123,
				identity: "birth",
				root,
				app: a.name,
				upstream: a.port,
				hostname,
				createdAt: 0,
			},
		})),
	};
	const run: RunEntry = {
		sessionId: "fixture-session",
		projectPrefix: "lullu",
		projectName: "private",
		root,
		worktree: "tree-a",
		branch: "fix-login",
		pid: 123,
		startedAt: "now",
		updatedAt: "now",
		hosts: null,
		cli: { program: "private" },
		services: [],
		apps: apps.map((a) => ({
			...a,
			url: "private",
			loopbackUrl: "private",
			status: a.name === "platform" ? "ready" : "starting",
		})),
	};
	const actual = {
		TCP: Object.fromEntries(apps.map((a) => [a.port, { HTTPS: true }])),
		Web: Object.fromEntries(
			apps.map((a) => [
				`${hostname}:${a.port}`,
				{ Handlers: { "/": { Proxy: `http://127.0.0.1:${a.port}` } } },
			]),
		),
	};
	const snapshot = directorySnapshot(
		{ id: "fixture-machine", hostname, online: true },
		state,
		[run],
		actual,
		Date.parse("2026-09-07T12:00:00Z"),
	);
	const fixture: unknown = JSON.parse(
		readFileSync(
			new URL("../../../menubar/fixtures/tailnet.v1.json", import.meta.url),
			"utf8",
		),
	);
	expect(fixture).toEqual(snapshot);
});

it("bounds streamed directory responses", async () => {
	await expect(readLimitedBody(new Response("123456"), 5)).rejects.toThrow(
		"too large",
	);
	expect(await readLimitedBody(new Response("hello"), 5)).toBe("hello");
});

it("validates the shared directory and rejects malformed variations", () => {
	const now = Date.parse("2026-09-07T12:00:00Z");
	const fixture: RemoteDirectory = JSON.parse(
		readFileSync(
			new URL("../../../menubar/fixtures/tailnet.v1.json", import.meta.url),
			"utf8",
		),
	);

	const parse = (value: unknown) =>
		parseRemoteDirectory(
			value,
			"devbox.tail123.ts.net",
			"fixture-machine",
			now,
		);

	expect(parse(fixture)).toMatchObject(fixture);

	// Change one field at a time so each rejection identifies a specific broken contract.
	const metadata: [string, Record<string, unknown>][] = [
		["unsupported version", { version: 2 }],
		["stale timestamp", { generatedAt: "2026-09-07T11:00:00.000Z" }],
		["future timestamp", { generatedAt: "2026-09-07T13:00:00.000Z" }],
		["wrong identity", { machineId: "other" }],
		["wrong host", { hostname: "other.tail123.ts.net" }],
	];

	for (const [name, patch] of metadata) {
		expect(() => parse({ ...fixture, ...patch }), name).toThrow();
	}

	const run = fixture.runs[0];
	const app = run.apps[0];
	const { apps: _, ...missingApps } = run;
	const invalidRuns: [string, unknown[]][] = [
		["duplicate run", [run, run]],
		["duplicate app", [{ ...run, apps: [...run.apps, app] }]],
		["invalid branch", [{ ...run, branch: "a".repeat(257) }]],
		["missing apps", [missingApps]],
	];

	for (const [name, runs] of invalidRuns) {
		expect(() => parse({ ...fixture, runs }), name).toThrow();
	}

	const invalidApps: [string, Record<string, string>][] = [
		["unsafe scheme", { url: "file:///etc/passwd" }],
		["wrong app host", { url: "https://other.tail123.ts.net:25173" }],
		["invalid app port", { url: "https://devbox.tail123.ts.net:443" }],
		["URL credentials", { url: "https://user@devbox.tail123.ts.net:25173" }],
		["invalid status", { status: "unknown" }],
		["empty app name", { name: "" }],
	];

	for (const [name, patch] of invalidApps) {
		const apps = [{ ...app, ...patch }, ...run.apps.slice(1)];
		expect(
			() => parse({ ...fixture, runs: [{ ...run, apps }] }),
			name,
		).toThrow();
	}
});
