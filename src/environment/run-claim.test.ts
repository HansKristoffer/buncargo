import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuns } from "../core/run-registry";
import type { DevEnvContext } from "./context";
import { createRunClaimApi, resolveClaimHold } from "./run-claim";

const realHome = process.env.HOME;
let home = "";

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-run-claim-"));
	process.env.HOME = home;
});

afterAll(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
});

describe("resolveClaimHold", () => {
	it("keeps a library run's containers unless something asks for a hold", () => {
		// A script that brings a stack up and exits looks like a crash to the
		// sweep; with a hold it would lose its containers seconds later.
		expect(resolveClaimHold({}, undefined)).toBeUndefined();
	});

	it("ignores `options.autoShutdown` for a library run, which is the CLI's", () => {
		// The configured hold is `buncargo dev`'s. Applied to a script that
		// exits normally, it is the crash path: containers gone in seconds.
		expect(resolveClaimHold({}, 60_000)).toBeUndefined();
		expect(
			resolveClaimHold({ defaultIdleTimeoutMs: 180_000 }, false),
		).toBeUndefined();
	});

	it("uses the caller's default only when neither the flag nor the config says", () => {
		// The CLI's three minutes.
		expect(resolveClaimHold({ defaultIdleTimeoutMs: 180_000 }, undefined)).toBe(
			180_000,
		);
		expect(resolveClaimHold({ defaultIdleTimeoutMs: 180_000 }, 60_000)).toBe(
			60_000,
		);
	});

	it("puts an explicit request above everything, `false` included", () => {
		expect(resolveClaimHold({ idleTimeoutMs: 5_000 }, 60_000)).toBe(5_000);
		expect(
			resolveClaimHold(
				{ idleTimeoutMs: false, defaultIdleTimeoutMs: 180_000 },
				60_000,
			),
		).toBeUndefined();
	});
});

describe("createRunClaimApi", () => {
	function claimApi() {
		return createRunClaimApi({
			config: { projectPrefix: "demo", services: {}, apps: {} },
			projectName: "demo-claim",
			root: home,
			worktree: false,
			services: { postgres: {} },
			selectedServiceKeys: ["postgres"],
			hasSelectedServices: true,
			runtime: { name: "docker" },
			runtimeBinary: "docker",
		} as unknown as DevEnvContext<
			Record<string, never>,
			Record<string, never>
		>);
	}

	async function holdOf(sessionId: string) {
		const entry = (await loadRuns()).find((run) => run.sessionId === sessionId);
		expect(entry).toBeDefined();
		return entry?.idleTimeoutMs;
	}

	it("keeps the hold it was first claimed with when `restart()` claims again", async () => {
		// `restart()` retires the claim and claims again with only a signal.
		// Resolving that afresh lost the hold, so the containers were kept
		// forever after a restart.
		const claim = claimApi();
		await claim.claimRun({ idleTimeoutMs: 5_000 });
		expect(await holdOf(claim.sessionId)).toBe(5_000);

		await claim.retireRun();
		await claim.claimRun({});
		expect(await holdOf(claim.sessionId)).toBe(5_000);

		await claim.retireRun();
		await claim.claimRun({ idleTimeoutMs: false });
		expect(await holdOf(claim.sessionId)).toBeUndefined();
		await claim.retireRun();
	});
});
