import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A child that saw the developer's HOME or a reachable Docker would run the
// sweep against the real machine (AGENTS.md, "The ways to hurt yourself").
it.skipIf(process.platform === "win32")(
	"hands a spawned child the run's isolated environment",
	async () => {
		const script = 'printf "%s\\n%s" "$HOME" "$DOCKER_HOST"';
		const expected = `${process.env.HOME}\n${process.env.DOCKER_HOST}`;

		const sync = Bun.spawnSync(["sh", "-c", script]);
		expect(sync.stdout.toString()).toBe(expected);

		const child = Bun.spawn({ cmd: ["sh", "-c", script], stdout: "pipe" });
		expect(await new Response(child.stdout).text()).toBe(expected);
	},
);

// `bun run test` runs files in parallel workers, each file in a fresh global:
// the preload, and its isolation, has to reach every one of them.
it.skipIf(process.platform === "win32")(
	"gives every file of a parallel run its own HOME and no reachable Docker",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-isolation-probe-"));
		try {
			const probe = `import { test } from "bun:test";
test("probe", () => console.log("PROBE" + JSON.stringify({ home: process.env.HOME, docker: process.env.DOCKER_HOST, binary: Bun.which("docker") })));`;
			const files = ["a", "b"].map((name) => join(dir, `${name}.probe.ts`));
			for (const file of files) writeFileSync(file, probe);
			const run = Bun.spawn(
				[process.execPath, "test", "--parallel=2", ...files],
				{
					cwd: join(import.meta.dir, ".."),
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr] = await Promise.all([
				new Response(run.stdout).text(),
				new Response(run.stderr).text(),
			]);
			expect(await run.exited).toBe(0);
			const seen = `${stdout}${stderr}`
				.split("\n")
				.filter((line) => line.startsWith("PROBE"))
				.map(
					(line) =>
						JSON.parse(line.slice("PROBE".length)) as {
							home: string;
							docker: string;
							binary: string;
						},
				);
			expect(seen).toHaveLength(2);
			expect(new Set(seen.map((file) => file.home)).size).toBe(2);
			for (const file of seen) {
				expect(file.home).toStartWith(join(tmpdir(), "buncargo-test-home-"));
				expect(file.docker).toBe("unix:///nonexistent/buncargo-test.sock");
				expect(file.binary).toStartWith(
					join(tmpdir(), "buncargo-test-runtimes-"),
				);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
