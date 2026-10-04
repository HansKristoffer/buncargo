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
				"loaded by users' vite.config.ts; imports nothing by design",
		};
		const read = /\benv(?:\.|\[["'])(BUNCARGO_\w+|CI)\b(?!["']?\]?\s*=[^=])/g;

		const offenders = sourceFiles()
			.filter((file) => !(file in allowed))
			.flatMap((file) =>
				[...readFileSync(join(ROOT, file), "utf8").matchAll(read)].map(
					(match) => `${file}: ${match[1]}`,
				),
			);

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
});
