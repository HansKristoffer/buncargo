import { expect, it } from "bun:test";
import type { RunEntry } from "../run-registry";
import { remoteStop } from "./daemon";
import type { TailnetSnapshot } from "./directory";

const run: RunEntry = {
	sessionId: "session",
	projectPrefix: "lullu",
	projectName: "private",
	root: "/private/checkout",
	worktree: null,
	pid: 123,
	startedAt: "now",
	updatedAt: "now",
	hosts: null,
	cli: { program: "bun", script: "buncargo.js" },
	services: [],
	apps: [],
};

const snapshot: TailnetSnapshot = {
	version: 1,
	machineId: "machine",
	hostname: "devbox.tail123.ts.net",
	generatedAt: "now",
	runs: [
		{
			id: "session",
			project: "lullu",
			worktree: null,
			branch: null,
			primaryApp: null,
			apps: [{ name: "platform", status: "ready", url: "https://x" }],
		},
	],
};

it("stops only advertised targets through the run's own buncargo", async () => {
	const calls: string[][] = [];
	const exec = async (entry: RunEntry, argv: string[]) => {
		calls.push([entry.cli.program, ...argv]);
		return { code: argv[1] === "--all" ? 3 : 0, stderr: "refused" };
	};

	expect(await remoteStop("nope", snapshot, [run], exec)).toEqual({
		status: 400,
		error: "Invalid stop request",
	});
	expect(
		(await remoteStop({ run: "other" }, snapshot, [run], exec)).status,
	).toBe(404);
	expect(
		(await remoteStop({ run: "session", app: "api" }, snapshot, [run], exec))
			.status,
	).toBe(404);
	expect(calls).toHaveLength(0);

	expect(
		await remoteStop(
			{ run: "session", app: "platform" },
			snapshot,
			[run],
			exec,
		),
	).toEqual({
		status: 200,
	});
	expect(await remoteStop({ run: "session" }, snapshot, [run], exec)).toEqual({
		status: 403,
		error: "refused",
	});
	expect(calls).toEqual([
		["bun", "stop", "platform", "--force"],
		["bun", "stop", "--all", "--force"],
	]);
});
