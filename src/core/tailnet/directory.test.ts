import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { RunEntry } from "../run-registry";
import { directorySnapshot } from "./directory";
import { readLimitedBody } from "./peers";
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
