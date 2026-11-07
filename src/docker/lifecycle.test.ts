import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerRuntimeAdapter } from "./adapter";
import { startContainers, stopContainers } from "./lifecycle";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

/** A `docker` that answers every command with success and records its argv. */
function fakeDocker(
	options: {
		downStderr?: string;
		upStderr?: string;
		psStdout?: string;
		/** Refuse `docker version` with this on stderr. */
		versionStderr?: string;
		/** Never answer `down`, as a hung daemon does. */
		downHangs?: boolean;
	} = {},
) {
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
const versionStderr = ${JSON.stringify(options.versionStderr ?? "")};
if (args[0] === 'version' && versionStderr) {
  process.stderr.write(versionStderr);
  process.exit(1);
}
if (args[0] === 'version') console.log('27.5.1');
if (args[0] === 'ps') console.log(${JSON.stringify(options.psStdout ?? "")});
if (${options.downHangs === true} && args.includes('down')) setInterval(() => {}, 1000);
const downStderr = ${JSON.stringify(options.downStderr ?? "")};
if (downStderr && args.includes('down')) {
  process.stderr.write(downStderr);
  process.exit(1);
}
const upStderr = ${JSON.stringify(options.upStderr ?? "")};
if (upStderr && args.includes('up')) {
  process.stderr.write(upStderr);
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
			verbose: false,
		});
		expect(calls().at(-1)).toEqual(["compose", "-p", "demo", "down"]);
	});

	it("fails when it could not name the volumes it was asked to remove", async () => {
		const { dir, binary, calls } = fakeDocker();
		const gone = join(dir, "deleted-worktree");
		await expect(
			stopContainers(gone, "demo", {
				binary,
				composeFile: ".buncargo/compose.yml",
				removeVolumes: true,
				verbose: false,
			}),
		).rejects.toThrow(/Removed demo's containers but kept its volumes/);
		// The containers still come down.
		expect(calls().at(-1)).toEqual(["compose", "-p", "demo", "down"]);
	});

	it("finds a compose file relative to the checkout from any working directory", async () => {
		const { dir, binary, calls } = fakeDocker();
		mkdirSync(join(dir, ".buncargo"));
		writeFileSync(join(dir, ".buncargo", "compose.yml"), "services: {}\n");
		const elsewhere = join(dir, "apps", "platform");
		mkdirSync(elsewhere, { recursive: true });

		const cwd = process.cwd();
		process.chdir(elsewhere);
		try {
			await stopContainers(dir, "demo", {
				binary,
				composeFile: ".buncargo/compose.yml",
				removeVolumes: true,
				verbose: false,
			});
		} finally {
			process.chdir(cwd);
		}

		expect(calls().at(-1)).toEqual([
			"compose",
			"-f",
			".buncargo/compose.yml",
			"-p",
			"demo",
			"down",
			"-v",
		]);
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

	it("does not call a daemon that refuses this user stopped after a streamed teardown failed", async () => {
		// Verbose streams compose's stderr to the terminal, so only the probe
		// is left to say why: a daemon this user may not open may still run
		// every container, and "Nothing to stop" would be a lie.
		const { dir, binary } = fakeDocker({
			downStderr: "permission denied",
			versionStderr:
				"permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
		});
		await expect(
			stopContainers(dir, "demo", { binary, verbose: true }),
		).rejects.toThrow(
			/Could not stop demo's containers.*cannot open its socket/,
		);
	});

	it("has nothing to stop when the probe after a streamed failure finds the daemon down", async () => {
		const down =
			"Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
		const { dir, binary } = fakeDocker({
			downStderr: down,
			versionStderr: down,
		});
		await stopContainers(dir, "demo", { binary, verbose: true });
	});

	it("refuses to report volumes removed while the daemon is stopped", async () => {
		const { dir, binary } = fakeDocker({
			downStderr:
				"Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
		});
		const composeFile = join(dir, "compose.yml");
		writeFileSync(composeFile, "services: {}\n");
		await expect(
			stopContainers(dir, "demo", {
				binary,
				composeFile,
				removeVolumes: true,
				verbose: false,
			}),
		).rejects.toThrow(/volumes of demo were not removed/);
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
		const { dir, binary } = fakeDocker({
			downStderr:
				"Error response from daemon: error while removing network: network demo_default has active endpoints",
		});
		await expect(
			stopContainers(dir, "demo", { binary, verbose: false }),
		).rejects.toThrow(/network demo_default has active endpoints/);
	});

	it("does not call a daemon that refuses this user stopped off compose's own failure", async () => {
		const { dir, binary } = fakeDocker({
			downStderr:
				'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/json": dial unix /var/run/docker.sock: connect: permission denied',
		});
		await expect(
			stopContainers(dir, "demo", { binary, verbose: false }),
		).rejects.toThrow(
			/Could not stop demo's containers.*cannot open its socket/,
		);
	});

	it("fails a teardown the daemon did not answer in time, rather than reporting nothing to stop", async () => {
		const { dir, binary } = fakeDocker({ downHangs: true });
		await expect(
			stopContainers(dir, "demo", { binary, verbose: false, timeoutMs: 300 }),
		).rejects.toThrow(
			/Could not stop demo's containers.*did not answer in time/,
		);
	});
});

describe("startContainers", () => {
	it("names the missing Compose plugin instead of passing Docker's words on", async () => {
		const { dir, binary } = fakeDocker({
			upStderr: "docker: 'compose' is not a docker command.",
		});
		await expect(
			startContainers(dir, "demo", {}, { binary, verbose: false }),
		).rejects.toThrow(/Docker Compose is not available to this process/);
	});

	it("names the container holding a port, asking the same docker that failed", async () => {
		const port = 47913;
		const { dir, binary } = fakeDocker({
			upStderr: `Bind for 0.0.0.0:${port} failed: port is already allocated`,
			psStdout: `abc123\tother-postgres-1\t0.0.0.0:${port}->5432/tcp\tother`,
		});
		await expect(
			startContainers(dir, "demo", {}, { binary, verbose: false }),
		).rejects.toThrow(
			`port ${port} held by container other-postgres-1 (project other)`,
		);
	});

	// Readiness is polled against the published ports afterwards, on both
	// backends; Compose's own `--wait` would only make `up` slower.
	it("starts the adapter's services without Compose's --wait", async () => {
		const { dir, binary, calls } = fakeDocker();
		await dockerRuntimeAdapter({ binary }).up({
			root: dir,
			projectName: "demo",
			envVars: {},
			model: { services: {} },
			serviceNames: ["postgres"],
			verbose: false,
		});
		expect(calls().at(-1)).toEqual([
			"compose",
			"-p",
			"demo",
			"up",
			"-d",
			"postgres",
		]);
	});
});
