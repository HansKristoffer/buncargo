/**
 * Rules about how the source is put together, each one broken at least once.
 * Fix the code rather than widening an allow-list; an entry needs a reason a
 * reviewer can check.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = import.meta.dir;
const ROOT = dirname(SRC);
const transpiler = new Bun.Transpiler({ loader: "ts" });

function sourceFiles(): string[] {
	return [...new Bun.Glob("**/*.ts").scanSync(SRC)]
		.filter((path) => !/\.test\.ts$|\.testing\.ts$/.test(path))
		.map((path) => `src/${path}`);
}

/** Every module reachable from `entry` through relative, non-type imports. */
function importGraph(entry: string): Set<string> {
	const seen = new Set<string>();
	const pending = [resolve(ROOT, entry)];

	while (pending.length > 0) {
		const file = pending.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);

		for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
			if (!path.startsWith(".")) continue;
			const base = resolve(dirname(file), path);
			const target = [base, `${base}.ts`, join(base, "index.ts")].find(
				(candidate) => candidate.endsWith(".ts") && existsSync(candidate),
			);
			if (target) pending.push(target);
		}
	}

	return new Set([...seen].map((file) => relative(ROOT, file)));
}

describe("architecture", () => {
	it("reads BUNCARGO_* and CI only through core/runtime-flags.ts", () => {
		// Tests inject a plain environment into the getters there, and nothing
		// is captured at import time.
		const allowed: Record<string, string> = {
			"src/core/runtime-flags.ts": "the single reader",
			"src/vite/index.ts":
				"loaded by users' vite.config.ts; its import graph is pinned below",
			"src/vite/resolve.ts": "the same plugin's environment reading",
		};
		const read = /\benv(?:\.|\[["'])(BUNCARGO_\w+|CI)\b(?!["']?\]?\s*=[^=])/g;
		// A name held in a constant escapes `read`: `env[NAME]` is a read too.
		const named = /\bconst\s+\w+\s*=\s*["'](BUNCARGO_\w+)["']/g;

		const offenders = sourceFiles()
			.filter((file) => !(file in allowed))
			.flatMap((file) => {
				const source = readFileSync(join(ROOT, file), "utf8");
				return [...source.matchAll(read), ...source.matchAll(named)].map(
					(match) => `${file}: ${match[1]}`,
				);
			});

		expect(offenders).toEqual([]);
	});

	it("never hides the container runtime by emptying PATH", () => {
		// With PATH empty, Bun falls back to /usr/bin and finds the real
		// `docker`; a watchdog or sweep run that way with an isolated HOME sees
		// every stack on the machine as unowned. Keep the test preload's stubs
		// on PATH, or use a directory of your own, and point DOCKER_HOST at
		// nothing. This happened in a test and in scripts/verify-package.ts.
		const allowed: Record<string, string> = {
			"src/core/tool-binary.test.ts":
				"calls lookupOnPath, a pure function, with an empty PATH; spawns nothing",
			"src/core/process/user-scope.test.ts":
				"calls inOwnUserScope, which only builds argv; spawns nothing",
		};
		const emptied = /\bPATH\s*[:=]\s*(["'`])\1/;
		const files = [
			...[...new Bun.Glob("**/*.ts").scanSync(SRC)].map(
				(path) => `src/${path}`,
			),
			...[...new Bun.Glob("**/*.ts").scanSync(join(ROOT, "scripts"))].map(
				(path) => `scripts/${path}`,
			),
		];

		const offenders = files
			.filter((file) => !(file in allowed))
			.filter((file) => emptied.test(readFileSync(join(ROOT, file), "utf8")));

		expect(offenders).toEqual([]);
	});

	it("keeps the hosts daemon bundle free of the CLI side", () => {
		// dist/hostsd.js is the one file a root launchd job executes. The client
		// reaches for the container runtimes to name a :443 squatter, and
		// core/utils pulls in port allocation and the host plan.
		const graph = importGraph("src/cli/hostsd.ts");
		const forbidden = [...graph].filter(
			(file) =>
				file === "src/core/hosts/daemon-client.ts" ||
				file === "src/core/utils.ts" ||
				/^src\/(container-runtime|docker|apple-container|environment|config)\//.test(
					file,
				),
		);

		expect(graph.has("src/core/hosts/daemon.ts")).toBe(true);
		expect(forbidden).toEqual([]);
	});

	it("keeps the sweep out of the watchdog module every run loads", () => {
		// core/watchdog.ts is a published subpath and on every run's path to
		// ensureWatchdog. Its loop needs only the sweep's types; a value import
		// once tripled its graph.
		const graph = importGraph("src/core/watchdog.ts");
		expect(graph.has("src/container-runtime/sweep.ts")).toBe(false);
	});

	it("keeps the entry points loaded inside users' apps small", () => {
		// vite.config.ts, browser bundles and app servers load these. Any new
		// module here ships into every project's app; keep each one a leaf.
		const pinned: Record<string, string[]> = {
			"src/vite/index.ts": [
				"src/vite/index.ts",
				"src/vite/resolve.ts",
				"src/core/tailscale.ts",
			],
			"src/client/index.ts": ["src/client/index.ts"],
			"src/runtime/index.ts": [
				"src/runtime/index.ts",
				"src/client/index.ts",
				"src/core/runtime-flags.ts",
				"src/core/connect/origin.ts",
			],
		};

		for (const [entry, allowed] of Object.entries(pinned)) {
			expect([...importGraph(entry)].sort()).toEqual([...allowed].sort());
		}
	});
});
