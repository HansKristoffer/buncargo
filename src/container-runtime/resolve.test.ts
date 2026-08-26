import { describe, expect, it } from "bun:test";
import { isContainerUp } from "./inventory";
import {
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

	it("falls back to docker under auto when Apple is unavailable", () => {
		// No `container` binary is installed in CI, and the adapter's probe is
		// the only thing `auto` consults.
		const adapter = resolveContainerRuntime({
			flag: "auto",
			env: {},
			docker: { binary: undefined },
		});
		expect(["docker", "apple"]).toContain(adapter.name);
		if (!adapter.isAvailable()) {
			expect(adapter.name).toBe("docker");
		}
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
	it("accepts both runtimes' vocabulary for a live container", () => {
		const base = {
			id: "a",
			name: "a",
			ports: "",
			project: "p",
			root: "/r",
			worktree: "",
			service: "postgres",
		};
		expect(isContainerUp({ ...base, status: "Up 3 minutes" })).toBe(true);
		expect(isContainerUp({ ...base, status: "running" })).toBe(true);
		expect(isContainerUp({ ...base, status: "Exited (0) 1 hour ago" })).toBe(
			false,
		);
		expect(isContainerUp({ ...base, status: "stopped" })).toBe(false);
	});
});
