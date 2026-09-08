import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForAllServices } from "../container-runtime/readiness";
import { dockerRuntimeAdapter } from "./adapter";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture(
	options: {
		ids?: string;
		listExit?: number;
		listDelay?: number;
		execExit?: number;
		execDelay?: number;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "buncargo docker probe "));
	roots.push(root);
	const log = join(root, "calls.jsonl");
	const pid = join(root, "exec.pid");
	const state = join(root, "options.json");
	const script = join(root, "fake.ts");
	const binary = join(root, "docker binary");
	writeFileSync(state, JSON.stringify(options));
	writeFileSync(
		script,
		`
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const options = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'));
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'ps') {
  await Bun.sleep(options.listDelay ?? 0);
  console.log(options.ids ?? 'abcdef123456');
  process.exit(options.listExit ?? 0);
}
if (args[0] === 'exec') {
  writeFileSync(${JSON.stringify(pid)}, String(process.pid));
  await Bun.sleep(options.execDelay ?? 0);
  process.exit(options.execExit ?? 0);
}
// Compose must never be used by a probe, even on the first start.
process.exit(9);
`,
	);
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(
		binary,
		`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
	);
	chmodSync(binary, 0o700);
	const runtime = dockerRuntimeAdapter({ binary });
	const execInServiceAsync = runtime.execInServiceAsync;
	if (!execInServiceAsync)
		throw new Error("Docker must implement async probes");
	return {
		root,
		state,
		runtime: { ...runtime, execInServiceAsync },
		calls: () =>
			readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]),
		execPid: () => Number(readFileSync(pid, "utf8")),
	};
}

describe("Docker service probes", () => {
	it("checks a cold service without Compose or an already-healthy runtime snapshot", async () => {
		const { root, runtime, calls } = fixture();
		await waitForAllServices(
			{
				db: {
					port: 5432,
					serviceName: "postgres",
					healthCheck: "pg_isready",
					healthTimeout: 2000,
				},
			},
			{ db: 10232 },
			{
				runtime,
				projectName: "new-worktree",
				root,
				composeFile: "absent.yml",
				healthyServices: new Set(),
				verbose: false,
			},
		);
		expect(calls()).toEqual([
			[
				"ps",
				"--filter",
				"label=com.docker.compose.project=new-worktree",
				"--filter",
				"label=com.docker.compose.service=postgres",
				"--filter",
				"label=com.docker.compose.oneoff=False",
				"--filter",
				"label=com.docker.compose.container-number=1",
				"--format",
				"{{.ID}}",
			],
			[
				"exec",
				"abcdef123456",
				"pg_isready",
				"-h",
				"127.0.0.1",
				"-U",
				"postgres",
			],
		]);
	});

	for (const mode of ["sync", "async"] as const) {
		it(`${mode}: preserves argv and re-resolves a recreated container`, async () => {
			const { root, runtime, state, calls } = fixture();
			const exec =
				mode === "sync" ? runtime.execInService : runtime.execInServiceAsync;
			const request = {
				root,
				projectName: "demo",
				serviceName: "cache",
				command: ["redis-cli", "literal argument", "$(not-a-shell)"],
			};
			expect(await exec(request)).toBe(true);
			writeFileSync(state, JSON.stringify({ ids: "123456abcdef" }));
			expect(await exec(request)).toBe(true);
			expect(calls().filter((args) => args[0] === "exec")).toEqual([
				["exec", "abcdef123456", ...request.command],
				["exec", "123456abcdef", ...request.command],
			]);
		});

		for (const options of [
			{ ids: "" },
			{ ids: "abcdef123456\n123456abcdef" },
			{ listExit: 1 },
		]) {
			it(`${mode}: never executes with a missing, ambiguous or failed lookup ${JSON.stringify(options)}`, async () => {
				const { root, runtime, calls } = fixture(options);
				const exec =
					mode === "sync" ? runtime.execInService : runtime.execInServiceAsync;
				expect(
					await exec({
						root,
						projectName: "demo",
						serviceName: "db",
						command: ["pg_isready"],
					}),
				).toBe(false);
				expect(calls()).toHaveLength(1);
			});
		}

		it(`${mode}: treats a failing probe as not ready`, async () => {
			const { root, runtime } = fixture({ execExit: 1 });
			const exec =
				mode === "sync" ? runtime.execInService : runtime.execInServiceAsync;
			expect(
				await exec({
					root,
					projectName: "demo",
					serviceName: "db",
					command: ["pg_isready"],
				}),
			).toBe(false);
		});

		it(`${mode}: shares the timeout between lookup and exec and leaves no probe process`, async () => {
			const { root, runtime, execPid } = fixture({
				listDelay: 350,
				execDelay: 500,
			});
			const exec =
				mode === "sync" ? runtime.execInService : runtime.execInServiceAsync;
			expect(
				await exec({
					root,
					projectName: "demo",
					serviceName: "db",
					command: ["pg_isready"],
					timeoutMs: 800,
				}),
			).toBe(false);
			expect(() => process.kill(execPid(), 0)).toThrow();
		});
	}

	it("cancels an in-flight exec and waits for its process to exit", async () => {
		const { root, runtime, execPid } = fixture({ execDelay: 5000 });
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new Error("cancel probe")),
			350,
		);
		try {
			await expect(
				runtime.execInServiceAsync({
					root,
					projectName: "demo",
					serviceName: "db",
					command: ["pg_isready"],
					signal: controller.signal,
				}),
			).rejects.toThrow("cancel probe");
			expect(() => process.kill(execPid(), 0)).toThrow();
		} finally {
			clearTimeout(timer);
		}
	});
});
