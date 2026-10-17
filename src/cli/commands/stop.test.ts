import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessIdentityAsync } from "../../core/process-identity";
import { loadRuns, publishRun, type RunEntry } from "../../core/run-registry";
import { handleStop } from "./stop";

/**
 * `HOME` is a temporary directory and the only runtime is a fake `docker`
 * that records its calls, so nothing here reaches the machine's containers.
 * `BUNCARGO_CONTAINER_BINARY` points at the fake too: a runtime probe would
 * find it, which is how a test sees a probe that should not happen.
 */
let root: string;
let docker: string;
const saved = {
	HOME: process.env.HOME,
	BUNCARGO_CONTAINER_BINARY: process.env.BUNCARGO_CONTAINER_BINARY,
	BUNCARGO_CONTAINER_RUNTIME: process.env.BUNCARGO_CONTAINER_RUNTIME,
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "buncargo-stop-"));
	docker = join(root, "docker");
	writeFileSync(docker, `#!/bin/sh\necho "$*" >> "${root}/calls"\nexit 0\n`, {
		mode: 0o755,
	});
	process.env.HOME = root;
	process.env.BUNCARGO_CONTAINER_BINARY = docker;
	process.env.BUNCARGO_CONTAINER_RUNTIME = "docker";
});

afterEach(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

const calls = () =>
	existsSync(join(root, "calls"))
		? readFileSync(join(root, "calls"), "utf-8").trim().split("\n")
		: [];

function entry(sessionId: string, extra: Partial<RunEntry> = {}): RunEntry {
	const now = new Date().toISOString();
	return {
		sessionId,
		projectPrefix: "fixture",
		projectName: "fixture",
		root,
		worktree: null,
		pid: 2 ** 22 + 1,
		startedAt: now,
		updatedAt: now,
		hosts: null,
		cli: { program: "bun" },
		apps: [],
		services: [],
		...extra,
	};
}

/** A run released into the idle hold: its owner has exited, its container waits. */
function held(sessionId: string): RunEntry {
	return entry(sessionId, {
		releasedAt: new Date().toISOString(),
		idleTimeoutMs: 180_000,
		services: [
			{
				name: "db",
				status: "ready",
				container: {
					runtime: "docker",
					binary: docker,
					service: "db",
					name: "fixture-db",
				},
			},
		],
	});
}

/** A live run whose owner is a real process this test spawned. */
async function live(sessionId: string, extra: Partial<RunEntry> = {}) {
	const owner = Bun.spawn(
		[process.execPath, "--eval", "setInterval(() => {}, 1000)"],
		{ stdout: "ignore", stderr: "ignore" },
	);
	const processIdentity = await readProcessIdentityAsync(owner.pid);
	await publishRun(
		entry(sessionId, {
			pid: owner.pid,
			processIdentity,
			detached: true,
			...extra,
		}),
	);
	return owner;
}

describe("buncargo stop --all", () => {
	it("leaves alone a stack in another run's idle hold when the stopped run records no container", async () => {
		await publishRun(held("held"));
		const owner = await live("app-only");
		try {
			expect(
				await handleStop(["--all", "--root", root, "--run", "app-only"]),
			).toBe(0);
			expect(await owner.exited).not.toBeUndefined();
			expect(calls().filter((call) => call.includes("down"))).toEqual([]);
			expect((await loadRuns()).map((run) => run.sessionId)).toContain("held");
		} finally {
			owner.kill("SIGKILL");
		}
	});

	it("takes down the containers a released run left in the idle hold, and retires its entry", async () => {
		await publishRun(held("held"));
		expect(await handleStop(["--all", "--root", root])).toBe(0);
		expect(calls()).toContain("compose -p fixture down");
		expect(await loadRuns()).toEqual([]);
	});

	it("takes down a live run's containers and its project's released runs together", async () => {
		await publishRun(held("held"));
		const owner = await live("dev", { services: held("dev").services });
		try {
			expect(await handleStop(["--all", "--root", root])).toBe(0);
			expect(await owner.exited).not.toBeUndefined();
			expect(calls()).toContain("compose -p fixture down");
			expect(await loadRuns()).toEqual([]);
		} finally {
			owner.kill("SIGKILL");
		}
	});

	it("leaves a run in another terminal, and what its project holds, without confirmation", async () => {
		await publishRun(held("held"));
		const owner = await live("dev", {
			detached: false,
			services: held("dev").services,
		});
		try {
			expect(await handleStop(["--all", "--root", root])).toBe(3);
			expect(owner.exitCode).toBeNull();
			expect(calls().filter((call) => call.includes("down"))).toEqual([]);
			expect((await loadRuns()).map((run) => run.sessionId).sort()).toEqual([
				"dev",
				"held",
			]);
		} finally {
			owner.kill("SIGKILL");
		}
	});

	it("reports nothing to stop when the checkout has no run at all", async () => {
		expect(await handleStop(["--all", "--root", root])).toBe(2);
	});
});
