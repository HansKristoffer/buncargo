import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CI_ENV_VARS } from "./runtime-flags";

/**
 * Run `body` with every CI signal cleared, then put the environment back.
 *
 * For tests that assert behaviour buncargo deliberately turns off in CI —
 * named hosts, Docker auto-start. They have to look like a developer's
 * machine, and the interesting assertion is the one CI would otherwise skip.
 *
 * Clearing `CI` by hand is what these tests used to do, and it was wrong on
 * exactly one machine: the GitHub Actions runner, which also sets
 * `GITHUB_ACTIONS`. The list comes from {@link CI_ENV_VARS} so it cannot drift
 * from the detector again.
 *
 * Not in a `.test.ts` file because Bun would then treat it as a suite with no
 * tests in it.
 */
export function withoutCiEnv<T>(body: () => T): T {
	const saved = new Map<string, string | undefined>();
	for (const name of CI_ENV_VARS) {
		saved.set(name, process.env[name]);
		delete process.env[name];
	}
	try {
		return body();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

/**
 * Give the calling test file a temporary `HOME` for all of its tests, so the
 * run entries, leases and port claims its library starts write never reach
 * the developer's `~/.buncargo`.
 *
 * A start there still ensures a watchdog unless it passes `watchdog: false`,
 * and one spawned from a test outlives it with this `HOME` and, once the
 * preload's stubs are gone, the real container runtime: every real stack
 * would look unowned to it. Pass `watchdog: false` as well.
 */
export function isolateHome(prefix = "buncargo-home-"): void {
	const saved = process.env.HOME;
	let home = "";
	beforeAll(() => {
		home = mkdtempSync(join(tmpdir(), prefix));
		process.env.HOME = home;
	});
	afterAll(() => {
		if (saved === undefined) delete process.env.HOME;
		else process.env.HOME = saved;
		rmSync(home, { recursive: true, force: true });
	});
}
