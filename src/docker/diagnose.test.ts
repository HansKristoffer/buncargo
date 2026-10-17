import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseDockerService, parseDockerPsState } from "./diagnose";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

/** A `docker` that lists one container by label and fails any Compose call. */
function fakeDocker(psLine: string) {
	const root = mkdtempSync(join(tmpdir(), "buncargo docker diagnose "));
	roots.push(root);
	const log = join(root, "calls.jsonl");
	const script = join(root, "fake.ts");
	const binary = join(root, "docker binary");
	writeFileSync(
		script,
		`
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'ps') console.log(${JSON.stringify(psLine)});
else if (args[0] === 'logs') { console.log('starting'); console.error('FATAL: boom'); }
else process.exit(9);
`,
	);
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(
		binary,
		`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
	);
	chmodSync(binary, 0o700);
	return {
		root,
		binary,
		calls: () =>
			readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]),
	};
}

describe("parseDockerPsState", () => {
	it("reads the exit code out of an exited container's status", () => {
		expect(
			parseDockerPsState("abc123\texited\tExited (1) 3 seconds ago"),
		).toEqual({ id: "abc123", state: "exited", exitCode: 1 });
	});

	it("leaves the exit code out while the container runs", () => {
		expect(
			parseDockerPsState("abc123\trunning\tUp 2 seconds (health: starting)"),
		).toEqual({ id: "abc123", state: "running", exitCode: undefined });
	});

	it("finds nothing in an empty listing", () => {
		expect(parseDockerPsState("")).toBeUndefined();
	});
});

describe("diagnoseDockerService", () => {
	it("reports an exited job by its labels, without Compose", async () => {
		const { root, binary, calls } = fakeDocker(
			"abc123\texited\tExited (3) 1 second ago",
		);

		const diagnosis = await diagnoseDockerService(
			{ root, projectName: "demo", serviceName: "migrate" },
			binary,
		);

		expect(diagnosis).toEqual({
			state: "exited",
			exitCode: 3,
			logTail: "starting\nFATAL: boom",
		});
		expect(calls().map((args) => args[0])).toEqual(["ps", "logs"]);
		expect(calls()[0]).toContain("label=com.docker.compose.service=migrate");
		expect(calls()[1]).toEqual(["logs", "--tail=20", "abc123"]);
	});

	it("finds nothing when no container carries the labels", async () => {
		const { root, binary } = fakeDocker("");
		expect(
			await diagnoseDockerService(
				{ root, projectName: "demo", serviceName: "migrate" },
				binary,
			),
		).toBeUndefined();
	});
});
