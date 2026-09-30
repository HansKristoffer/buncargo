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
import {
	DockerUnavailableError,
	ensureDockerRunning,
	isDockerDaemonRunning,
} from "./preflight";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture(
	options: { versionExit?: number; versionDelay?: number } = {},
) {
	const root = mkdtempSync(join(tmpdir(), "buncargo docker preflight "));
	roots.push(root);
	const log = join(root, "calls.jsonl");
	const pidFile = join(root, "probe.pid");
	const script = join(root, "fake.ts");
	const binary = join(root, "docker binary");
	writeFileSync(
		script,
		`
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "info") {
  // Docker info also gathers CLI plugin metadata, which can be slow even
  // when the daemon is ready. Reproduce that independently of real Docker.
  await Bun.sleep(6000);
  console.log("27.5.1");
} else if (args[0] === "version") {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  await Bun.sleep(${options.versionDelay ?? 0});
  console.log("27.5.1");
  process.exit(${options.versionExit ?? 0});
} else if (args[0] === "context") {
  console.log("default");
} else {
  process.exit(9);
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
		binary,
		pidFile,
		calls: () =>
			readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]),
	};
}

describe("Docker daemon preflight", () => {
	it("checks the server without collecting slow CLI plugin metadata", async () => {
		const { binary, calls } = fixture();
		await ensureDockerRunning({
			binary,
			autoStart: false,
			verbose: false,
			timeoutMs: 1000,
		});
		expect(isDockerDaemonRunning(binary)).toBe(true);
		expect(calls()).toEqual([
			["version", "--format", "{{.Server.Version}}"],
			["version", "--format", "{{.Server.Version}}"],
		]);
	});

	it("rejects an unavailable server even if the CLI prints a version", async () => {
		const { binary } = fixture({ versionExit: 1 });
		expect(isDockerDaemonRunning(binary)).toBe(false);
		await expect(
			ensureDockerRunning({ binary, autoStart: false, verbose: false }),
		).rejects.toBeInstanceOf(DockerUnavailableError);
	});

	it("bounds a stalled server probe and leaves no owned process", async () => {
		const { binary, pidFile } = fixture({ versionDelay: 6000 });
		await expect(
			ensureDockerRunning({
				binary,
				autoStart: false,
				verbose: false,
				timeoutMs: 500,
			}),
		).rejects.toBeInstanceOf(DockerUnavailableError);
		expect(() =>
			process.kill(Number(readFileSync(pidFile, "utf8")), 0),
		).toThrow();
	});

	it("cancels a stalled server probe after cleaning up its process", async () => {
		const { binary, pidFile } = fixture({ versionDelay: 6000 });
		const controller = new AbortController();
		const outcome = ensureDockerRunning({
			binary,
			autoStart: false,
			verbose: false,
			signal: controller.signal,
		}).catch((error: unknown) => error);
		try {
			const deadline = performance.now() + 4000;
			while (
				!(await Bun.file(pidFile).exists()) &&
				performance.now() < deadline
			)
				await Bun.sleep(20);
			const pid = Number(readFileSync(pidFile, "utf8"));
			controller.abort(new Error("cancel daemon probe"));
			expect(await outcome).toMatchObject({ message: "cancel daemon probe" });
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			controller.abort();
			await outcome;
		}
	});
});
