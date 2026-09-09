import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readProcessIdentity } from "../process-identity";
import type { RunEntry } from "../run-registry";
import { CONNECT_ORIGIN, parseDirectory, parseRun } from "./protocol";
import { runTargets } from "./targets";

test("Swift and CLI decode the same named directory and reject redirected target URLs", () => {
	const fixture = JSON.parse(
		readFileSync(
			new URL("../../../menubar/fixtures/connect.v1.json", import.meta.url),
			"utf8",
		),
	);
	fixture.generatedAt = Date.now();
	const d = parseDirectory(fixture, CONNECT_ORIGIN);
	expect(d.runs[0].name).toBe("Cursor cloud");
	expect(d.runs[0].targets[1].url).toBe("");
	for (const url of [
		"https://evil.example/",
		"http://" + "b".repeat(32) + ".connect.hanskristoffer.dk/",
		"https://" + "b".repeat(32) + ".connect.hanskristoffer.dk.evil.example/",
	]) {
		const copy = structuredClone(fixture);
		copy.runs[0].targets[0].url = url;
		expect(() => parseDirectory(copy, CONNECT_ORIGIN)).toThrow();
	}
});
test("projecting a selected run omits workers/jobs and retains process identity", () => {
	const identity = readProcessIdentity(process.pid);
	const run: RunEntry = {
		sessionId: "fixture",
		cli: { program: process.execPath },
		pid: process.pid,
		processIdentity: identity,
		root: "/tmp/fixture",
		projectPrefix: "test",
		projectName: "test",
		worktree: null,
		hosts: null,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		apps: [
			{
				name: "api",
				port: 3000,
				status: "ready",
				pid: process.pid,
				processIdentity: identity,
			},
			{ name: "worker", kind: "worker", status: "ready" },
		],
		services: [
			{ name: "db", preset: "postgres", port: 5432, status: "ready" },
			{ name: "job", kind: "job", port: 9999, status: "ready" },
		],
	};
	const targets = runTargets(run);
	expect(targets.map((t) => t.name)).toEqual(["api", "db"]);
	expect(targets[0].processIdentity).toBe(identity);
	expect(targets[1].protocol).toBe("tcp");
});
test("publication validation rejects oversized, duplicate and foreign database metadata", () => {
	const base = {
		sessionId: "run",
		name: "Cursor",
		hostname: "sandbox",
		project: "project",
		worktree: null,
		targets: [
			{
				id: "db",
				name: "db",
				kind: "service",
				protocol: "tcp",
				status: "ready",
				port: 5432,
				tablePlusUrl: "postgresql://dev:password@127.0.0.1:5432/test",
			},
		],
	};
	expect(parseRun(base).targets).toHaveLength(1);
	expect(() => parseRun({ ...base, name: "x".repeat(81) })).toThrow();
	expect(() =>
		parseRun({ ...base, targets: [base.targets[0], base.targets[0]] }),
	).toThrow();
	expect(() =>
		parseRun({
			...base,
			targets: [
				{
					...base.targets[0],
					tablePlusUrl: "postgresql://evil.example:5432/test",
				},
			],
		}),
	).toThrow();
});
