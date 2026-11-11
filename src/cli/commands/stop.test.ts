import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadHostRoutes,
	pidRouteOwners,
	upsertHostRoutes,
} from "../../core/hosts/registry";
import {
	claimOffset,
	offsetClaimHoldsBlock,
	offsetClaimKey,
	readAllOffsetClaims,
	withOffsetClaimsLock,
} from "../../core/offset-claims";
import * as terminate from "../../core/process/terminate";
import { runStopGraceMs } from "../../core/process/terminate";
import { readProcessIdentityAsync } from "../../core/process-identity";
import { recordEvents, runStopRecord } from "../../core/removal-log";
import {
	CHECKOUT_HOLD,
	LIVE,
	loadRuns,
	publishRun,
	type RunEntry,
	releaseRun,
} from "../../core/run-registry";
import { runCommand } from "../command-spec";
import { stopCommand } from "./stop";

const handleStop = (args: string[]) => runCommand(stopCommand, args);

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

/** What `stop` printed to one console stream, and its exit code. */
async function capture(stream: "log" | "error", run: () => Promise<number>) {
	const lines: string[] = [];
	const spy = spyOn(console, stream).mockImplementation((line) => {
		lines.push(Bun.stripANSI(String(line)));
	});
	try {
		const code = await run();
		return { code, text: lines.join("\n") };
	} finally {
		spy.mockRestore();
	}
}

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
		lifecycle: LIVE,
		hold: CHECKOUT_HOLD,
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
		lifecycle: { state: "released", at: new Date().toISOString() },
		hold: { kind: "timed", ms: 180_000, inherited: false },
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

	it("keeps the block of a stack still in another run's hold when it downs nothing", async () => {
		// An app-only run's stop downed nothing, yet released the suffixed
		// claim the held run's stack was using.
		withOffsetClaimsLock(() =>
			claimOffset({
				root,
				offset: 300,
				ports: [5732],
				projectName: "fixture",
				suffix: "e2e",
			}),
		);
		await publishRun(held("held"));
		const owner = await live("app-only");
		try {
			expect(
				await handleStop(["--all", "--root", root, "--run", "app-only"]),
			).toBe(0);
			expect(Object.keys(readAllOffsetClaims())).toEqual([
				offsetClaimKey(root, "e2e"),
			]);
		} finally {
			owner.kill("SIGKILL");
		}
	});

	it("takes down the containers a released run left in the idle hold, retires its entry and gives back its block", async () => {
		withOffsetClaimsLock(() =>
			claimOffset({
				root,
				offset: 300,
				ports: [5732],
				projectName: "fixture",
				suffix: "e2e",
			}),
		);
		await publishRun(held("held"));
		expect(await handleStop(["--all", "--root", root])).toBe(0);
		expect(calls()).toContain("compose -p fixture down");
		expect(await loadRuns()).toEqual([]);
		// The claim stays without its block, naming the project its volumes
		// belong to.
		const claim = readAllOffsetClaims()[offsetClaimKey(root, "e2e")];
		expect(claim?.projectName).toBe("fixture");
		expect(claim && offsetClaimHoldsBlock(claim)).toBe(false);
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

	// 3 means "left running on purpose", and BuncargoBar offers --force on
	// it; a runtime that failed the teardown is no refusal to force past.
	it("exits 1 when the teardown fails, keeping the entry for another try", async () => {
		writeFileSync(
			docker,
			`#!/bin/sh\necho "$*" >> "${root}/calls"\ncase "$*" in *down*) exit 1 ;; esac\nexit 0\n`,
		);
		await publishRun(held("held"));
		expect(await handleStop(["--all", "--root", root])).toBe(1);
		expect((await loadRuns()).map((run) => run.sessionId)).toEqual(["held"]);
	});

	it("succeeds and says so when the checkout has no run at all", async () => {
		const printed = await capture("log", () =>
			handleStop(["--all", "--root", root]),
		);
		expect(printed.code).toBe(0);
		expect(printed.text).toContain("Nothing running for this checkout");
	});

	it("still names an app or service that matches no run", async () => {
		expect(await handleStop(["api", "--root", root])).toBe(2);
	});

	it("treats a run that ended between the read and the signal as stopped, and takes down what it left", async () => {
		const owner = await live("dev", { services: held("dev").services });
		// The run exits on its own and releases into the hold just before the
		// signal would reach it.
		const signal = spyOn(terminate, "terminateProcessGroup").mockImplementation(
			async () => {
				owner.kill("SIGKILL");
				await owner.exited;
				await releaseRun("dev");
				return false;
			},
		);
		try {
			expect(await handleStop(["--all", "--root", root])).toBe(0);
			expect(calls()).toContain("compose -p fixture down");
			expect(await loadRuns()).toEqual([]);
		} finally {
			signal.mockRestore();
			owner.kill("SIGKILL");
		}
	});

	it("removes the checkout's service routes, and no other checkout's", async () => {
		await upsertHostRoutes(
			[
				{
					hostname: "typesense.fixture.localhost",
					port: 8108,
					kind: "service",
					name: "typesense",
					root,
				},
				{
					hostname: "typesense.other.localhost",
					port: 9108,
					kind: "service",
					name: "typesense",
					root: tmpdir(),
				},
			],
			{ owners: pidRouteOwners },
		);
		await publishRun(held("held"));
		expect(await handleStop(["--all", "--root", root])).toBe(0);
		expect((await loadHostRoutes()).map((route) => route.hostname)).toEqual([
			"typesense.other.localhost",
		]);
	});
});

describe("buncargo stop arguments", () => {
	it("exits 1 on an unknown flag, which is not a refusal", async () => {
		expect(await handleStop(["--frce", "--root", root])).toBe(1);
	});
});

describe("buncargo stop with no target", () => {
	// Agents and project docs write a bare `buncargo stop` meaning "stop my
	// run"; it used to fail with "Name at least one app or service".
	it("stops this checkout's detached run, containers included", async () => {
		const owner = await live("dev", { services: held("dev").services });
		try {
			expect(await handleStop(["--root", root])).toBe(0);
			expect(await owner.exited).not.toBeUndefined();
			expect(calls()).toContain("compose -p fixture down");
			expect(await loadRuns()).toEqual([]);
		} finally {
			owner.kill("SIGKILL");
		}
	});

	it("leaves a run in another terminal running without a terminal to ask in", async () => {
		const owner = await live("dev", {
			detached: false,
			services: held("dev").services,
		});
		try {
			expect(await handleStop(["--root", root])).toBe(3);
			expect(owner.exitCode).toBeNull();
			expect(calls().filter((call) => call.includes("down"))).toEqual([]);
		} finally {
			owner.kill("SIGKILL");
		}
	});
});

describe("buncargo stop after the watchdog stopped the run", () => {
	it("says why the run is gone", async () => {
		await recordEvents([
			runStopRecord(entry("idle", { detached: true }), {
				at: new Date().toISOString(),
				reason: "idle",
				detail: "idle for 2h 0m",
			}),
		]);
		const printed = await capture("log", () => handleStop(["--root", root]));
		expect(printed.code).toBe(0);
		expect(printed.text).toContain(
			"buncargo's watchdog stopped fixture's detached run (pid 4194305)",
		);
		expect(printed.text).toContain("idle for 2h 0m");
	});
});

describe("runStopGraceMs", () => {
	it("gives a run its own teardown time on top of its slowest app", () => {
		expect(runStopGraceMs({ apps: [] })).toBe(5000);
		expect(
			runStopGraceMs({
				apps: [
					{ name: "web", status: "ready" },
					{ name: "firebase", status: "ready", stopGraceMs: 60_000 },
				],
			}),
		).toBe(65_000);
	});
});
