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
import { isContainerUp } from "./inventory";
import {
	containerRuntimeCandidates,
	containerRuntimeForEnv,
	resolveContainerRuntime,
	resolveContainerRuntimeBinary,
	resolveContainerRuntimeSelection,
} from "./resolve";

describe("resolveContainerRuntimeSelection", () => {
	it("defaults to docker so existing projects are untouched", () => {
		expect(resolveContainerRuntimeSelection({ env: {} })).toBe("docker");
	});

	it("reads config.docker.runtime", () => {
		expect(
			resolveContainerRuntimeSelection({
				docker: { runtime: "apple" },
				env: {},
			}),
		).toBe("apple");
	});

	it("lets the environment override the config", () => {
		expect(
			resolveContainerRuntimeSelection({
				docker: { runtime: "apple" },
				env: { BUNCARGO_CONTAINER_RUNTIME: "docker" },
			}),
		).toBe("docker");
	});

	it("lets the flag override the environment", () => {
		expect(
			resolveContainerRuntimeSelection({
				flag: "auto",
				docker: { runtime: "apple" },
				env: { BUNCARGO_CONTAINER_RUNTIME: "docker" },
			}),
		).toBe("auto");
	});

	it("ignores an empty environment value", () => {
		expect(
			resolveContainerRuntimeSelection({
				docker: { runtime: "apple" },
				env: { BUNCARGO_CONTAINER_RUNTIME: "  " },
			}),
		).toBe("apple");
	});

	it("names the source when a value is invalid", () => {
		expect(() =>
			resolveContainerRuntimeSelection({ flag: "podman", env: {} }),
		).toThrow(/--runtime "podman" is invalid/);
		expect(() =>
			resolveContainerRuntimeSelection({
				env: { BUNCARGO_CONTAINER_RUNTIME: "podman" },
			}),
		).toThrow(/BUNCARGO_CONTAINER_RUNTIME "podman" is invalid/);
	});
});

describe("resolveContainerRuntime", () => {
	it("returns the named backend without probing it", () => {
		expect(resolveContainerRuntime({ flag: "docker", env: {} }).name).toBe(
			"docker",
		);
		expect(resolveContainerRuntime({ flag: "apple", env: {} }).name).toBe(
			"apple",
		);
	});

	it("picks Apple under auto whenever it is installed, running or not", () => {
		// After a reboot Apple's service is down; picking Docker then would
		// move the project onto Docker's volumes.
		expect(
			resolveContainerRuntime({
				flag: "auto",
				env: {},
				appleInstalled: () => true,
			}).name,
		).toBe("apple");
	});

	it("picks docker under auto when Apple is not installed", () => {
		expect(
			resolveContainerRuntime({
				flag: "auto",
				env: {},
				appleInstalled: () => false,
			}).name,
		).toBe("docker");
	});
});

describe("resolveContainerRuntimeBinary", () => {
	it("is undefined when nothing overrides the PATH lookup", () => {
		expect(resolveContainerRuntimeBinary({ env: {} })).toBeUndefined();
	});

	it("reads the environment override", () => {
		// Any real path will do; the getter rejects one that does not exist.
		expect(
			resolveContainerRuntimeBinary({
				env: { BUNCARGO_CONTAINER_BINARY: process.execPath },
			}),
		).toBe(process.execPath);
	});

	it("rejects an override pointing nowhere", () => {
		expect(() =>
			resolveContainerRuntimeBinary({
				env: { BUNCARGO_CONTAINER_BINARY: "/nope/docker" },
			}),
		).toThrow(/does not exist/);
	});

	it("lets the config pin the binary over a stray export", () => {
		expect(
			resolveContainerRuntimeBinary({
				docker: { binary: "/usr/local/bin/docker" },
				env: { BUNCARGO_CONTAINER_BINARY: "/nope/docker" },
			}),
		).toBe("/usr/local/bin/docker");
	});
});

describe("containerRuntimeCandidates", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	function recordingBinary() {
		const root = mkdtempSync(join(tmpdir(), "buncargo-runtime-binary-"));
		roots.push(root);
		const binary = join(root, "container");
		const log = join(root, "calls.log");
		writeFileSync(binary, `#!/bin/sh\necho "$@" >> '${log}'\nexit 1\n`);
		chmodSync(binary, 0o700);
		return {
			binary,
			calls: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
		};
	}

	/** What the Docker candidate executed while listing. */
	function dockerListCalls(env: NodeJS.ProcessEnv, calls: () => string) {
		const docker = containerRuntimeCandidates({ env }).find(
			(adapter) => adapter.name === "docker",
		);
		expect(docker).toBeDefined();
		try {
			docker?.list();
		} catch {
			// Both stubs fail; only which binary ran matters here.
		}
		return calls();
	}

	it("gives the environment's binary only to the runtime the environment names", () => {
		const { binary, calls } = recordingBinary();
		expect(
			dockerListCalls(
				{
					BUNCARGO_CONTAINER_RUNTIME: "apple",
					BUNCARGO_CONTAINER_BINARY: binary,
				},
				calls,
			),
		).toBe("");
	});

	it("gives it to Docker when the environment names no runtime", () => {
		const { binary, calls } = recordingBinary();
		expect(
			dockerListCalls({ BUNCARGO_CONTAINER_BINARY: binary }, calls),
		).not.toBe("");
	});
});

describe("containerRuntimeForEnv", () => {
	it("rebuilds the runtime an environment resolved", () => {
		// The binary has to survive the round trip, or a project pinning one gets
		// a different `docker` from `status`, `doctor` and prisma than from `dev`.
		const runtime = containerRuntimeForEnv({
			containerRuntime: "apple",
			containerRuntimeBinary: "/opt/bin/container",
		});
		expect(runtime.name).toBe("apple");
	});
});

describe("isContainerUp", () => {
	it("reads the state, not the human status line", () => {
		const base = {
			id: "a",
			name: "a",
			ports: "",
			project: "p",
			root: "/r",
			worktree: "",
			service: "postgres",
		};
		expect(
			isContainerUp({ ...base, state: "running", status: "Up 3 minutes" }),
		).toBe(true);
		// Both runtimes spell it the same, so Apple needs no second vocabulary.
		expect(
			isContainerUp({ ...base, state: "running", status: "running" }),
		).toBe(true);
		// "Exited (0) 1 hour ago" and "Up 3 minutes" both contain a word the
		// old substring match accepted; only the state separates them.
		expect(
			isContainerUp({
				...base,
				state: "exited",
				status: "Exited (0) 1 hour ago",
			}),
		).toBe(false);
		expect(
			isContainerUp({ ...base, state: "stopped", status: "stopped" }),
		).toBe(false);
		expect(isContainerUp({ ...base, state: "paused", status: "Paused" })).toBe(
			false,
		);
	});
});
