import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CI_ENV_VARS } from "./runtime-flags";

/**
 * Remove a temporary directory and everything inside it, restoring `0o700` on
 * directories first so unreadable or read-only fixtures (`0o000`, `0o555`) are
 * deleted instead of leaking under `tmpdir()`.
 */
export function removeTempDir(dir: string): void {
	if (!dir) return;
	makeRemovable(dir);
	rmSync(dir, { recursive: true, force: true });
}

function makeRemovable(path: string): void {
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(path);
	} catch {
		return;
	}
	if (stats.isSymbolicLink() || !stats.isDirectory()) return;
	try {
		chmodSync(path, 0o700);
	} catch {
		return;
	}
	let entries: string[];
	try {
		entries = readdirSync(path);
	} catch {
		return;
	}
	for (const entry of entries) {
		makeRemovable(join(path, entry));
	}
}

/**
 * Run `body` with every CI signal cleared, then put the environment back.
 *
 * For tests that assert behaviour buncargo deliberately turns off in CI:
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

	const restore = () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};

	let result: T;
	try {
		result = body();
	} catch (error) {
		restore();
		throw error;
	}
	// An async body reads the environment after its first await, so the
	// signals stay cleared until it settles.
	if (result instanceof Promise) return result.finally(restore) as T;

	restore();
	return result;
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
		removeTempDir(home);
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
