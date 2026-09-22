import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readProcessIdentity } from "../process-identity";
import type { RunEntry } from "../run-registry";
import { newKeyPair } from "./identity";
import {
	encodeToken,
	parseDirectory,
	parseHello,
	parseOpen,
	parseReply,
	parseRun,
	parseRuns,
	parseToken,
} from "./protocol";
import { runTargets } from "./targets";

function fixture() {
	const value = JSON.parse(
		readFileSync(
			new URL("../../../menubar/fixtures/connect.v1.json", import.meta.url),
			"utf8",
		),
	);
	value.generatedAt = Date.now();
	return value;
}

test("Swift and CLI decode the same directory and reject addresses off this computer", () => {
	const directory = parseDirectory(fixture());
	expect(directory.runs[0]?.name).toBe("Cursor cloud");
	expect(directory.runs[0]?.targets[0]?.url).toBe("http://127.0.0.1:49731/");
	expect(directory.runs[0]?.targets[1]?.tablePlusUrl).toContain("127.0.0.1");

	for (const url of [
		"http://10.0.0.5:49731/",
		"http://127.0.0.1:49999/",
		"https://evil.example/",
		"http://127.0.0.1:49731/admin",
		"http://user:secret@127.0.0.1:49731/",
		"file:///etc/passwd",
	]) {
		const copy = fixture();
		copy.runs[0].targets[0].url = url;
		expect(() => parseDirectory(copy)).toThrow();
	}

	const foreign = fixture();
	foreign.runs[0].targets[1].tablePlusUrl =
		"postgresql://dev:secret@db.example:49732/example";
	expect(() => parseDirectory(foreign)).toThrow();

	const anonymous = fixture();
	anonymous.runs[0].publisherId = "not-an-endpoint";
	expect(() => parseDirectory(anonymous)).toThrow();

	const stale = fixture();
	stale.generatedAt = Date.now() - 31_000;
	expect(() => parseDirectory(stale)).toThrow();
});

test("a token carries a receiver endpoint and its publishing secret, and nothing else", () => {
	const { endpointId } = newKeyPair();
	const secret = "a".repeat(64);
	const token = encodeToken({ endpointId, secret });
	expect(token).toStartWith("bc_share_");
	expect(parseToken(token)).toEqual({ endpointId, secret });

	for (const invalid of [
		"",
		"bc_share_",
		`bc_share_${endpointId}`,
		`bc_share_${endpointId}${secret}extra`,
		`bc_owner_${endpointId}${secret}`,
		`bc_share_${endpointId.toUpperCase()}${secret}`,
	]) {
		expect(() => parseToken(invalid)).toThrow();
	}
	expect(() => encodeToken({ endpointId: "short", secret })).toThrow();
});

test("handshake, run and stream messages reject anything they did not define", () => {
	const secret = "b".repeat(64);
	expect(
		parseHello({ type: "hello", secret, name: "Mac", hostname: "h" }).name,
	).toBe("Mac");
	expect(() =>
		parseHello({ type: "hello", secret: "short", name: "Mac", hostname: "h" }),
	).toThrow();
	expect(() =>
		parseHello({ type: "runs", secret, name: "Mac", hostname: "h" }),
	).toThrow();
	expect(() =>
		parseHello({ type: "hello", secret, name: "x".repeat(81), hostname: "h" }),
	).toThrow();

	const run = {
		sessionId: "run",
		name: "Cursor",
		hostname: "sandbox",
		project: "project",
		worktree: null,
		targets: [],
	};
	expect(parseRuns({ type: "runs", runs: [run] }).runs).toHaveLength(1);
	expect(() => parseRuns({ type: "runs", runs: [run, run] })).toThrow();
	expect(() => parseRuns({ type: "runs", runs: {} })).toThrow();

	expect(
		parseOpen({ type: "open", sessionId: "s", targetId: "t" }).targetId,
	).toBe("t");
	expect(() => parseOpen({ type: "open", sessionId: "s" })).toThrow();

	expect(parseReply({ type: "ok" })).toBeUndefined();
	expect(() =>
		parseReply({ type: "error", message: "Target is not running" }),
	).toThrow("Target is not running");
	expect(() => parseReply({})).toThrow();
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
	expect(targets[0]?.processIdentity).toBe(identity);
	expect(targets[1]?.protocol).toBe("tcp");
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
