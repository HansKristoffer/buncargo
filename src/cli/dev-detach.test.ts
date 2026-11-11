import { describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunEntry } from "../core/run-registry";
import { standInForWatchdog } from "../core/watchdog.testing";
import {
	detachedArgv,
	detachedLogPath,
	pruneDetachedFiles,
	runDetached,
	settledRun,
	unreportedApps,
} from "./dev-detach";
import type { DetachedResultJson } from "./json-documents";

describe("detachedArgv", () => {
	it("re-runs the same invocation without --detach", () => {
		expect(
			detachedArgv(
				["bun", "/x/bin.js", "dev", "--detach", "--apps=api"],
				"/bin/bun",
			),
		).toEqual(["/bin/bun", "/x/bin.js", "dev", "--apps=api"]);
	});

	it("leaves --keep out too: the run reads it from its environment", () => {
		expect(
			detachedArgv(
				["bun", "/x/bin.js", "dev", "--detach", "--keep"],
				"/bin/bun",
			),
		).toEqual(["/bin/bun", "/x/bin.js", "dev"]);
	});

	it("passes the attached app's args after -- through untouched", () => {
		expect(
			detachedArgv(
				["bun", "/x/bin.js", "dev", "--detach", "--", "--detach"],
				"/bin/bun",
			),
		).toEqual(["/bin/bun", "/x/bin.js", "dev", "--", "--detach"]);
	});
});

describe("settledRun", () => {
	const run = (apps: RunEntry["apps"], services: RunEntry["services"] = []) =>
		({ apps, services }) as RunEntry;

	it("waits for every app, and is not fooled by the claim's empty list", () => {
		expect(settledRun(run([]), true)).toBe(false);
		expect(
			settledRun(
				run([
					{ name: "api", status: "ready" },
					{ name: "web", status: "starting" },
				]),
				true,
			),
		).toBe(false);
		expect(
			settledRun(
				run([
					{ name: "api", status: "ready" },
					{ name: "web", status: "failed" },
				]),
				true,
			),
		).toBe(true);
	});

	it("settles a config without apps once its services are ready", () => {
		expect(
			settledRun(run([], [{ name: "postgres", status: "starting" }]), false),
		).toBe(false);
		expect(
			settledRun(run([], [{ name: "postgres", status: "ready" }]), false),
		).toBe(true);
	});
});

describe("runDetached", () => {
	/**
	 * `runDetached` over a stand-in for the re-run `dev`: a script that prints
	 * and exits. HOME and the systemd scope are the test's own, so it reads an
	 * empty registry and starts no scope on the machine.
	 */
	async function detach(
		script: string,
		options: {
			before?: (root: string) => void;
			after?: (root: string) => void;
			timeoutMs?: number;
			/** `dev --detach` again in the same checkout, once the first returned. */
			again?: string;
		} = {},
	) {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-detach-")));
		options.before?.(root);
		const saved = {
			HOME: process.env.HOME,
			BUNCARGO_SYSTEMD_SCOPE: process.env.BUNCARGO_SYSTEMD_SCOPE,
		};
		process.env.HOME = join(root, "home");
		process.env.BUNCARGO_SYSTEMD_SCOPE = "0";
		const printed: string[] = [];
		const realLog = console.log;
		const realError = console.error;
		console.log = (...parts: unknown[]) => printed.push(parts.join(" "));
		console.error = (...parts: unknown[]) => printed.push(parts.join(" "));
		try {
			let code = 0;
			for (const [index, body] of [script, options.again].entries()) {
				if (body === undefined) continue;
				const runScript = join(root, `run-${index}.ts`);
				writeFileSync(runScript, body);
				code = await runDetached({
					root,
					keep: false,
					json: false,
					argv: ["bun", runScript],
					timeoutMs: options.timeoutMs ?? 10_000,
				});
			}
			options.after?.(root);
			return { code, printed: Bun.stripANSI(printed.join("\n")) };
		} finally {
			console.log = realLog;
			console.error = realError;
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	}

	// Attached `dev` exits 0 when every selected app already runs elsewhere;
	// the detached one exited 1 for the same run.
	it("exits 0 with the run's own words when it had nothing to start", async () => {
		const { code, printed } = await detach(
			'console.log("Selected apps are already running. Nothing to start.");',
		);
		expect(code).toBe(0);
		expect(printed).toContain("Nothing to start.");
	});

	// A second `dev --detach` in the same checkout truncated the log and
	// deleted the report of the first, which was still writing both. Then a
	// shared log rotated aside lost it: the third run's rotation renamed over
	// the file the first still wrote.
	it("leaves the log and report of a run still going alone", async () => {
		const logs = (root: string) => join(root, ".buncargo", "logs");
		const files: Record<string, string> = {};
		await detach('console.log("the second run");', {
			again: 'console.log("the third run");',
			before: (root) => {
				mkdirSync(logs(root), { recursive: true });
				writeFileSync(
					detachedLogPath(root, process.pid),
					"the first run's output\n",
				);
				writeFileSync(
					join(logs(root), `detached-report-${process.pid}.json`),
					'{"setupHints":[],"failures":[]}',
				);
			},
			after: (root) => {
				for (const name of readdirSync(logs(root)))
					files[name] = readFileSync(join(logs(root), name), "utf8");
			},
		});
		expect(files[`detached-${process.pid}.log`]).toBe(
			"the first run's output\n",
		);
		expect(files[`detached-report-${process.pid}.json`]).toContain("failures");
		const runLogs = Object.entries(files).filter(([name]) =>
			/^detached-\d+\.log$/.test(name),
		);
		expect(runLogs.map(([, text]) => text).sort()).toEqual([
			"the first run's output\n",
			"the second run\n",
			"the third run\n",
		]);
		// The one path to name: the newest run's log.
		expect(files["detached.log"]).toBe("the third run\n");
	});

	// Agents tell "still starting" from "failed" by the code, as with `wait`.
	it("exits 2 when the apps are still starting at the timeout", async () => {
		const { code, printed } = await detach("setTimeout(() => {}, 30_000);", {
			timeoutMs: 300,
		});
		// By the pid it printed, never by a pattern.
		const pid = Number(/the run keeps going \(pid (\d+)\)/.exec(printed)?.[1]);
		if (pid) process.kill(pid, "SIGTERM");
		expect(code).toBe(2);
	});
});

describe("pruneDetachedFiles", () => {
	/** A pid that has exited: its run is over. */
	async function deadPid(): Promise<number> {
		const child = Bun.spawn(["true"]);
		await child.exited;
		return child.pid;
	}

	function logsDir() {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-prune-")));
		const logs = join(root, ".buncargo", "logs");
		mkdirSync(logs, { recursive: true });
		return { root, logs };
	}

	/** Write `name` last modified at `mtimeMs`. */
	function file(logs: string, name: string, mtimeMs: number): string {
		const path = join(logs, name);
		writeFileSync(path, "{}");
		utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
		return path;
	}

	// The parent polls every 250ms: a child that wrote its report and died
	// lost it to a second `dev --detach` pruning in between.
	it("keeps a dead run's report for a minute, for its parent to read", async () => {
		const { root, logs } = logsDir();
		try {
			const now = Date.now();
			const pid = await deadPid();
			const fresh = file(logs, `detached-report-${pid}.json`, now - 1_000);
			pruneDetachedFiles(root, now);
			expect(existsSync(fresh)).toBe(true);
			pruneDetachedFiles(root, now + 60_000);
			expect(existsSync(fresh)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a live run's report however old", async () => {
		const { root, logs } = logsDir();
		try {
			const now = Date.now();
			const live = file(
				logs,
				`detached-report-${process.pid}.json`,
				now - 3_600_000,
			);
			pruneDetachedFiles(root, now);
			expect(existsSync(live)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// Each run's log is its own; the newest ended one stays, as the log of the
	// run before did.
	it("keeps the newest ended run's log and drops the older ones", async () => {
		const { root, logs } = logsDir();
		try {
			const now = Date.now();
			const [older, newer] = [await deadPid(), await deadPid()];
			const olderLog = file(logs, `detached-${older}.log`, now - 7_200_000);
			const newerLog = file(logs, `detached-${newer}.log`, now - 3_600_000);
			const live = file(logs, `detached-${process.pid}.log`, now - 9_000_000);
			pruneDetachedFiles(root, now);
			expect(existsSync(olderLog)).toBe(false);
			expect(existsSync(newerLog)).toBe(true);
			expect(existsSync(live)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("unreportedApps", () => {
	it("names the down apps the report does not explain yet", () => {
		const down = [
			{ name: "api", status: "stopped" },
			{ name: "web", status: "failed" },
		] as RunEntry["apps"];
		expect(
			unreportedApps(down, {
				setupHints: [],
				hostsWarnings: [],
				failures: [{ cause: "", step: "web", output: [], hints: [], next: [] }],
			}),
		).toEqual(["api"]);
		expect(unreportedApps(down, undefined)).toEqual(["api", "web"]);
	});
});

/**
 * `runDetached` in a process of its own over a stand-in run script, for the
 * failure paths: their last lines are written past Bun's stderr buffer, which
 * no console patch in this process sees.
 */
function detachInProcess(
	script: (root: string) => string,
	options: { json?: boolean } = {},
) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-detach-")));
	try {
		const detach = join(import.meta.dir, "dev-detach.ts");
		writeFileSync(join(root, "run.ts"), script(root));
		writeFileSync(
			join(root, "parent.ts"),
			`import { runDetached } from ${JSON.stringify(detach)};
process.exitCode = await runDetached({
	root: ${JSON.stringify(root)},
	keep: false,
	json: ${options.json === true},
	argv: ["bun", ${JSON.stringify(join(root, "run.ts"))}],
	timeoutMs: 10_000,
});
`,
		);
		const result = Bun.spawnSync([process.execPath, join(root, "parent.ts")], {
			cwd: root,
			env: {
				...process.env,
				HOME: join(root, "home"),
				BUNCARGO_SYSTEMD_SCOPE: "0",
				NO_COLOR: "1",
			},
		});
		return {
			code: result.exitCode,
			stdout: Bun.stripANSI(result.stdout.toString()),
			stderr: Bun.stripANSI(result.stderr.toString())
				.trimEnd()
				.split("\n")
				.map((line) => line.trim()),
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

it("exits 1 with the run's output, and the exit last, when it left no report", () => {
	const { code, stdout, stderr } = detachInProcess(
		() => 'console.error("boom"); process.exit(3);',
	);
	expect(code).toBe(1);
	expect(stdout).toContain("boom");
	expect(stderr.at(-2)).toBe(
		"❌ The run exited with code 3 before its apps came up.",
	);
	expect(stderr.at(-1)).toStartWith("Full output: ");
});

// `dev --detach` had no JSON, and learned of a named-hosts fallback by
// grepping its run's log for one sentence; the run now reports it.
it("prints the DetachedResultJson document, with the run's named-hosts warnings", () => {
	const detach = join(import.meta.dir, "dev-detach.ts");
	const registry = join(import.meta.dir, "..", "core", "run-registry.ts");
	const { code, stdout } = detachInProcess(
		(root) => `import { recordDetachedReport } from ${JSON.stringify(detach)};
import { buildRunEntry, publishRun } from ${JSON.stringify(registry)};
const root = ${JSON.stringify(root)};
recordDetachedReport(root, (report) => ({
	...report,
	expectApps: true,
	hostsWarnings: ["Named URLs unavailable: the daemon is down."],
}));
await publishRun({
	...buildRunEntry({ sessionId: "json", projectPrefix: "stub", projectName: "stub-json", root, isWorktree: false }),
	apps: [{ name: "api", port: 3000, url: "", loopbackUrl: "", openUrl: "http://localhost:3000", status: "ready" }],
});
setTimeout(() => {}, 30_000);
`,
		{ json: true },
	);
	const document = JSON.parse(stdout) as DetachedResultJson;
	// The stand-in run waits to be stopped.
	process.kill(document.pid, "SIGTERM");
	expect(code).toBe(0);
	expect(Object.keys(document).sort()).toEqual([
		"apps",
		"exitCode",
		"failures",
		"hostsWarnings",
		"idleLimitMs",
		"log",
		"outcome",
		"pid",
		"version",
	]);
	expect(document).toMatchObject({
		version: 1,
		outcome: "up",
		exitCode: 0,
		apps: [{ name: "api", status: "ready", url: "http://localhost:3000" }],
		hostsWarnings: ["Named URLs unavailable: the daemon is down."],
		failures: [],
	});
});

// `dev --detach | tail` showed "exited with code 1" first, a kilobyte-long
// warning after it and the cause somewhere above. The block that ends the
// output names the failed step and shows its last lines.
it("ends a failed detached run with the run's own failure block", () => {
	const detach = join(import.meta.dir, "dev-detach.ts");
	const { code, stdout, stderr } = detachInProcess(
		(root) => `import { recordDetachedReport } from ${JSON.stringify(detach)};
console.log("⚠ Loopback URLs point at this checkout: noise");
recordDetachedReport(${JSON.stringify(root)}, (report) => ({
	...report,
	failures: [{
		cause: "The seed failed with exit code 1: \`bun run seed.ts\`",
		step: "seed",
		output: ["dataQualityDuplicatesSeeder: MISSING_SECRETS"],
		hints: [],
		next: ["fix it, then \`buncargo dev --seed\` runs only the seed again"],
	}],
}));
process.exit(1);
`,
	);
	expect(code).toBe(1);
	expect(stdout).toContain("The run exited with code 1");
	expect(stdout).not.toContain("noise");
	expect(stderr).toEqual([
		"❌ The seed failed with exit code 1: `bun run seed.ts`",
		"Last lines of seed:",
		"dataQualityDuplicatesSeeder: MISSING_SECRETS",
		"Next: fix it, then `buncargo dev --seed` runs only the seed again",
	]);
});

// An app that never came up is stopped before it is reported failed, so the
// registry said `stopped` first, and the parent printed a generic failure
// with no output before the run had written why.
it("waits for the report of an app the registry says stopped", () => {
	const detach = join(import.meta.dir, "dev-detach.ts");
	const registry = join(import.meta.dir, "..", "core", "run-registry.ts");
	const { code, stdout, stderr } = detachInProcess(
		(root) => `import { recordDetachedReport } from ${JSON.stringify(detach)};
import { buildRunEntry, patchRun, publishRun } from ${JSON.stringify(registry)};
const entry = buildRunEntry({
	sessionId: "parked",
	projectPrefix: "stub",
	projectName: "stub-detach",
	root: ${JSON.stringify(root)},
	isWorktree: false,
});
recordDetachedReport(${JSON.stringify(root)}, (report) => ({ ...report, expectApps: true }));
await publishRun({
	...entry,
	apps: [{ name: "api", port: 3000, url: "", loopbackUrl: "", status: "stopped" }],
});
await Bun.sleep(400);
recordDetachedReport(${JSON.stringify(root)}, (report) => ({
	...report,
	failures: [{
		cause: 'App "api" did not become ready',
		step: "api",
		output: ["the real cause"],
		hints: [],
		next: [],
	}],
}));
await patchRun("parked", { apps: [{ name: "api", status: "failed" }] });
setTimeout(() => {}, 30_000);
`,
	);
	// The stand-in run waits to be stopped: by the pid it printed.
	const pid = Number(/pid (\d+) · output/.exec(stdout)?.[1]);
	if (pid) process.kill(pid, "SIGTERM");
	expect(code).toBe(1);
	expect(stderr).toContain("the real cause");
});

// The parent built the whole environment to learn whether the selection has
// apps, and the background run built it again: twice the config load and
// port reads on every `dev --detach`.
it("loads the config once, in the background run", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-detach-")));
	const loads = join(root, "loads");
	const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = Number(probe.port);
	probe.stop(true);
	writeFileSync(join(root, "package.json"), "{}");
	writeFileSync(
		join(root, "serve.ts"),
		'Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("ok") });',
	);
	const config = {
		projectPrefix: "detach-once",
		services: {},
		apps: { app: { port, devCommand: `${process.execPath} serve.ts` } },
		options: { worktreeIsolation: false, hosts: false },
	};
	writeFileSync(
		join(root, "dev.config.ts"),
		`import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(loads)}, \`\${process.pid}\\n\`);
export default ${JSON.stringify(config)};`,
	);
	await standInForWatchdog(root);
	const cli = [process.execPath, resolve(import.meta.dir, "bin.ts")];
	const env = {
		...process.env,
		HOME: root,
		CI: "1",
		BUNCARGO_PORT_OFFSET: "0",
		BUNCARGO_HOSTS: "0",
		BUNCARGO_SYSTEMD_SCOPE: "0",
	};
	const run = (args: string[]) =>
		Bun.spawn([...cli, ...args], {
			cwd: root,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	try {
		const detach = run(["dev", "--detach"]);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(detach.stdout).text(),
			new Response(detach.stderr).text(),
			detach.exited,
		]);
		expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
		const loaders = readFileSync(loads, "utf8").trim().split("\n");
		expect(loaders).toHaveLength(1);
		expect(loaders[0]).not.toBe(String(detach.pid));
	} finally {
		await run(["stop", "--all"]).exited;
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);
