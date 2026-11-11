import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerRuntimeUnavailableError } from "../container-runtime/types";
import { type DockerRunResult, runDocker, runDockerAsync } from "./binary";
import {
	DESKTOP_COLD_START_MS,
	DockerUnavailableError,
	dockerDaemonStateFrom,
	ensureDockerRunning,
	installedDockerRuntime,
	isDockerDaemonRunning,
	isDockerDesktopHung,
	parseDockerDesktopPids,
	parseElapsed,
	runtimeFromContext,
	unresponsiveDockerError,
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
		/** Refuse every `version` probe with this on stderr. */
		versionStderr?: string;
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
if (args[0] === "version") {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  const { readFileSync } = await import("node:fs");
  const probes = readFileSync(${JSON.stringify(log)}, "utf8").split("\\n").filter((line) => line.startsWith('["version"')).length;
  if (probes <= ${options.downFor ?? 0}) process.exit(1);
  if (${JSON.stringify(options.versionStderr ?? "")}) { console.error(${JSON.stringify(options.versionStderr ?? "")}); process.exit(1); }
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

	it("names a socket permission problem instead of waiting for a daemon that is up", async () => {
		const { binary } = fixture({
			versionStderr:
				"permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
		});
		await expect(
			ensureDockerRunning({ binary, ci: false, verbose: false }),
		).rejects.toThrow(/cannot open its socket.*docker group/);
	});

	it.skipIf(process.platform !== "linux")(
		"says how to start the Linux engine instead of waiting for a daemon nothing will start",
		async () => {
			const { binary, calls } = fixture({ versionExit: 1 });
			const startedAt = performance.now();
			await expect(
				ensureDockerRunning({ binary, ci: false, verbose: false }),
			).rejects.toThrow(/sudo systemctl start docker/);
			expect(performance.now() - startedAt).toBeLessThan(5000);
			expect(calls().filter((args) => args[0] === "version")).toHaveLength(1);
		},
	);

	it.skipIf(process.platform !== "linux")(
		"runs docker.startCommand for the Linux engine, then waits for it",
		async () => {
			const { binary } = fixture({ downFor: 2 });
			const marker = join(
				tmpdir(),
				`buncargo-start-${process.pid}-${Date.now()}`,
			);
			roots.push(marker);
			await ensureDockerRunning({
				binary,
				ci: false,
				verbose: false,
				timeoutMs: 10_000,
				startCommand: `touch '${marker}'`,
			});
			expect(existsSync(marker)).toBe(true);
		},
		15_000,
	);

	it("treats a bare docker on Linux as the engine, not Docker Desktop", () => {
		const everything = () => true;
		expect(runtimeFromContext("default", "linux", everything)).toBe(
			"docker-engine",
		);
		expect(runtimeFromContext("desktop-linux", "linux", everything)).toBe(
			"docker-desktop",
		);
	});

	it("lets the context name the runtime over whichever apps are installed", () => {
		// OrbStack installed, Docker Desktop selected: opening OrbStack would
		// wait out the timeout and skip Desktop's hang detection.
		const orbstackInstalled = (runtime: string) => runtime === "orbstack";
		expect(
			runtimeFromContext("desktop-linux", "darwin", orbstackInstalled),
		).toBe("docker-desktop");
		expect(runtimeFromContext("colima", "darwin", orbstackInstalled)).toBe(
			"colima",
		);
		expect(runtimeFromContext("default", "darwin", orbstackInstalled)).toBe(
			"orbstack",
		);
		expect(runtimeFromContext("", "darwin", () => false)).toBe("unknown");
	});

	// Off macOS no other runtime's app is installed to win first, so only the
	// binary decides whether Docker Desktop is the guess.
	it.skipIf(
		existsSync("/Applications") ||
			["colima", "podman"].some((tool) => Bun.which(tool)),
	)("asks the configured docker binary, not the one on PATH", () => {
		// `bun test` puts a stub `docker` on PATH.
		const guess = (binary: string) =>
			runtimeFromContext("", "darwin", installedDockerRuntime(binary));
		expect(guess("/nope/docker")).toBe("unknown");
		expect(guess(process.execPath)).toBe("docker-desktop");
	});

	it("reads only Docker's own 'cannot connect' as a daemon that is down", () => {
		const failed = (
			stderr: string,
			status: DockerRunResult["status"] = "exit",
		) =>
			dockerDaemonStateFrom({
				status,
				ok: false,
				exitCode: 1,
				stdout: "",
				stderr,
			}).state;
		expect(
			failed(
				"Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
			),
		).toBe("down");
		expect(failed("spawnSync docker ENOENT", "notFound")).toBe("down");
		expect(
			failed(
				"permission denied while trying to connect to the Docker daemon socket",
			),
		).toBe("denied");
		expect(failed("spawnSync docker ETIMEDOUT", "timedOut")).toBe("silent");
		expect(failed('context "gone" does not exist')).toBe("failed");
	});

	// Docker prefixes every failure that is not a refused connection with
	// "error during connect", so the prefix alone says nothing about the
	// daemon. Strings as the Docker CLI prints them.
	it("reads 'error during connect' as down only when the daemon is not there", () => {
		const failed = (stderr: string) =>
			dockerDaemonStateFrom({
				status: "exit",
				ok: false,
				exitCode: 1,
				stdout: "",
				stderr,
			}).state;
		expect(
			failed(
				'error during connect: this error may indicate that the docker daemon is not running: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.24/version": open //./pipe/docker_engine: The system cannot find the file specified.',
			),
		).toBe("down");
		expect(
			failed(
				'error during connect: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.40/version": open //./pipe/docker_engine: The system cannot find the file specified. In the default daemon configuration on Windows, the docker client must be run with elevated privileges to connect.',
			),
		).toBe("down");
		expect(
			failed(
				'error during connect: Get "https://192.168.99.100:2376/v1.47/version": dial tcp 192.168.99.100:2376: i/o timeout',
			),
		).toBe("failed");
		expect(
			failed(
				'error during connect: Get "http://docker.internal:2375/v1.47/version": context deadline exceeded',
			),
		).toBe("failed");
		expect(
			failed(
				'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/version": open //./pipe/dockerDesktopLinuxEngine: Access is denied.',
			),
		).toBe("failed");
	});

	it("reports a docker binary that is not there as notFound on both runners", async () => {
		const missing = join(
			tmpdir(),
			`buncargo-no-docker-${process.pid}`,
			"docker",
		);
		expect(runDocker(missing, ["version"]).status).toBe("notFound");
		expect((await runDockerAsync(missing, ["version"])).status).toBe(
			"notFound",
		);
		const { binary } = fixture({ versionExit: 1 });
		expect((await runDockerAsync(binary, ["version"])).status).toBe("exit");
	});

	// CI waits for a daemon until the deadline; a missing binary must not.
	it("fails at once without a docker binary instead of waiting for a daemon", async () => {
		const missing = join(
			tmpdir(),
			`buncargo-no-docker-${process.pid}`,
			"docker",
		);
		await expect(
			ensureDockerRunning({ binary: missing, ci: true, verbose: false }),
		).rejects.toThrow(/was not found/);
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
				// Long enough for the probe to start under suite load.
				timeoutMs: 1500,
			}),
		).rejects.toBeInstanceOf(DockerUnavailableError);
		// Read outside the assertion: a probe that never started would make
		// the read throw and the assertion pass without testing anything.
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
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

describe("Docker Desktop process detection", () => {
	it("finds this user's Docker Desktop processes by executable name only", () => {
		const ps = [
			"  101   501 /Applications/Docker.app/Contents/MacOS/Docker Desktop.app/Contents/MacOS/Docker Desktop",
			"  102   501 /Applications/Docker.app/Contents/MacOS/com.docker.backend",
			"  103     0 /Library/PrivilegedHelperTools/com.docker.vmnetd",
			"  104   502 /Applications/Docker.app/Contents/MacOS/com.docker.backend",
			"  105   501 /usr/local/bin/com.docker.backend-wrapper",
			"  106   501 /Applications/Docker.app/Contents/MacOS/com.docker.virtualization",
		].join("\n");
		expect(parseDockerDesktopPids(ps, 501)).toEqual([101, 102, 106]);
	});

	it("is a ContainerRuntimeUnavailableError, so one catch covers both runtimes", () => {
		const error = unresponsiveDockerError([102]);
		expect(error).toBeInstanceOf(ContainerRuntimeUnavailableError);
		expect(error.runtime).toBe("docker");
		expect(error.dockerRuntime).toBe("docker-desktop");
		expect(error.message).toStartWith("Docker Desktop is running (pid 102)");
	});

	it("names a hung Docker Desktop and the fix, not 'not running'", () => {
		const error = unresponsiveDockerError([102]);
		expect(error.message).toContain("is running (pid 102)");
		expect(error.message).toContain("buncargo doctor --fix");
		expect(error.message).not.toContain("is not running");
	});
});

describe("Docker Desktop hang detection", () => {
	it("reads ps elapsed times", () => {
		expect(parseElapsed("  01:05")).toBe(65_000);
		expect(parseElapsed("02:00:00")).toBe(7_200_000);
		expect(parseElapsed("1-00:00:01")).toBe(86_401_000);
		expect(parseElapsed("soon")).toBeUndefined();
	});

	// A Desktop still cold-starting must never be killed: that stops every
	// checkout's containers for nothing.
	it("calls Docker Desktop hung only once it is past a cold start", () => {
		expect(isDockerDesktopHung(65_000)).toBe(false);
		expect(isDockerDesktopHung(DESKTOP_COLD_START_MS)).toBe(true);
	});
});
