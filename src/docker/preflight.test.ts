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
	runtimeFromContext,
} from "./preflight";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture(
	options: {
		versionExit?: number;
		versionDelay?: number;
		/** Fail this many `version` probes first, then answer. */
		downFor?: number;
	} = {},
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
  const { readFileSync } = await import("node:fs");
  const probes = readFileSync(${JSON.stringify(log)}, "utf8").split("\\n").filter((line) => line.startsWith('["version"')).length;
  if (probes <= ${options.downFor ?? 0}) process.exit(1);
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
	it("waits for a daemon that is still coming up in CI instead of failing on one probe", async () => {
		const { binary, calls } = fixture({ downFor: 2 });
		await ensureDockerRunning({
			binary,
			ci: true,
			verbose: false,
			timeoutMs: 10_000,
		});
		// Never tried to start anything: CI only waits.
		expect(calls().every((args) => args[0] !== "start")).toBe(true);
		expect(
			calls().filter((args) => args[0] === "version").length,
		).toBeGreaterThanOrEqual(3);
	}, 15_000);

	it("checks the server without collecting slow CLI plugin metadata", async () => {
		const { binary, calls } = fixture();
		await ensureDockerRunning({
			binary,
			autoStart: false,
			ci: false,
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
			ensureDockerRunning({
				binary,
				autoStart: false,
				ci: false,
				verbose: false,
			}),
		).rejects.toBeInstanceOf(DockerUnavailableError);
	});

	it("bounds a stalled server probe and leaves no owned process", async () => {
		const { binary, pidFile } = fixture({ versionDelay: 6000 });
		await expect(
			ensureDockerRunning({
				binary,
				autoStart: false,
				ci: false,
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
			ci: false,
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

describe("runtimeFromContext", () => {
	it("follows a context that names its engine over installed apps", () => {
		// With Docker Desktop selected, an installed OrbStack must not be
		// started in its place.
		expect(runtimeFromContext("desktop-linux")).toBe("docker-desktop");
		expect(runtimeFromContext("orbstack")).toBe("orbstack");
		expect(runtimeFromContext("colima-dev")).toBe("colima");
	});
});

describe("a pinned engine", () => {
	it("is started without asking Docker's context", async () => {
		const { binary, calls } = fixture({ versionExit: 1 });
		const failure = await ensureDockerRunning({
			binary,
			engine: "orbstack",
			autoStart: false,
			ci: false,
			verbose: false,
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(DockerUnavailableError);
		expect((failure as DockerUnavailableError).runtime).toBe("orbstack");
		expect(calls().some((args) => args[0] === "context")).toBe(false);
	});
});
