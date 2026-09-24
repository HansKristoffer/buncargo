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
import { stopContainers } from "./lifecycle";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

/** A `docker` that answers every command with success and records its argv. */
function fakeDocker(options: { downStderr?: string } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "buncargo docker down "));
	roots.push(dir);
	const log = join(dir, "calls.jsonl");
	const script = join(dir, "fake.ts");
	const binary = join(dir, "docker binary");
	writeFileSync(
		script,
		`
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'info') console.log('27.5.1');
const downStderr = ${JSON.stringify(options.downStderr ?? "")};
if (downStderr && args.includes('down')) {
  process.stderr.write(downStderr);
  process.exit(1);
}
`,
	);
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(
		binary,
		`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
	);
	chmodSync(binary, 0o700);
	return {
		dir,
		binary,
		calls: () =>
			readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]),
	};
}

describe("stopContainers", () => {
	it("tears a stack down by project name when its checkout and compose file are gone", async () => {
		const { dir, binary, calls } = fakeDocker();
		const gone = join(dir, "deleted-worktree");
		await stopContainers(gone, "demo", {
			binary,
			composeFile: join(gone, ".buncargo", "compose.yml"),
			removeVolumes: true,
			verbose: false,
		});
		expect(calls().at(-1)).toEqual(["compose", "-p", "demo", "down"]);
	});

	it("hands compose the file, and the volumes flag, while the checkout exists", async () => {
		const { dir, binary, calls } = fakeDocker();
		const composeFile = join(dir, "compose.yml");
		writeFileSync(composeFile, "services: {}\n");
		await stopContainers(dir, "demo", {
			binary,
			composeFile,
			removeVolumes: true,
			verbose: false,
		});
		expect(calls().at(-1)).toEqual([
			"compose",
			"-f",
			composeFile,
			"-p",
			"demo",
			"down",
			"-v",
		]);
	});

	it("reads a stopped daemon off compose's own failure, without probing first", async () => {
		const { dir, binary, calls } = fakeDocker({
			downStderr:
				"Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
		});
		// A daemon that is not there has already stopped everything, so this
		// is success, not a failure to report.
		await stopContainers(dir, "demo", { binary, verbose: false });
		// One call: the `docker info` probe this used to pay on every teardown
		// is gone, because the failure itself carried the answer.
		expect(calls()).toEqual([["compose", "-p", "demo", "down"]]);
	});

	it("names the missing Compose plugin instead of passing Docker's words on", async () => {
		const { dir, binary } = fakeDocker({
			downStderr: "docker: 'compose' is not a docker command.",
		});
		await expect(
			stopContainers(dir, "demo", { binary, verbose: false }),
		).rejects.toThrow(/Docker Compose is not available to this process/);
	});

	it("still reports a teardown that failed for any other reason", async () => {
		const { dir, binary } = fakeDocker({ downStderr: "permission denied" });
		await expect(
			stopContainers(dir, "demo", { binary, verbose: false }),
		).rejects.toThrow(/permission denied/);
	});
});
