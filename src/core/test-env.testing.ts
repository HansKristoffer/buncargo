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
