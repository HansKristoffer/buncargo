import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
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
 * Give each test in the calling scope a fresh temporary `HOME`, or with
 * `"all"` one `HOME` that the scope's tests share, and put the previous one
 * back afterwards. Returns the current home's path.
 *
 * The preload already gives every test file a temporary `HOME`, so a test
 * calls this only when it must not see what earlier tests in the file left
 * under `~/.buncargo`, or needs the path.
 *
 * A start under it still ensures a watchdog unless it passes
 * `watchdog: false`, and one spawned from a test outlives it with this `HOME`
 * and, once the preload's stubs are gone, the real container runtime: every
 * real stack would look unowned to it. Pass `watchdog: false` as well.
 */
export function useTempHome(scope: "each" | "all" = "each"): () => string {
	let saved: string | undefined;
	let home = "";
	(scope === "each" ? beforeEach : beforeAll)(() => {
		saved = process.env.HOME;
		home = mkdtempSync(join(tmpdir(), "buncargo-home-"));
		process.env.HOME = home;
	});
	(scope === "each" ? afterEach : afterAll)(() => {
		if (saved === undefined) delete process.env.HOME;
		else process.env.HOME = saved;
		rmSync(home, { recursive: true, force: true });
	});
	return () => home;
}

/**
 * `count` different ports the OS just handed out and nothing listens on now.
 * A random port in a fixed range collides with other projects on the machine
 * and, in a parallel run, with other test files.
 */
export function freePorts(count: number): number[] {
	const listeners = Array.from({ length: count }, () =>
		Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }),
	);
	const ports = listeners.map((listener) => listener.port);
	for (const listener of listeners) listener.stop(true);
	return ports;
}
