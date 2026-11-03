import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEntry } from "../core/run-registry";
import {
	detachedArgv,
	namedHostsFallbacks,
	runDetached,
	settledRun,
} from "./dev-detach";

describe("namedHostsFallbacks", () => {
	// The parent prints only the app list, with localhost URLs, so the reason
	// they are not named ones has to be lifted out of the run's own output.
	it("finds the run's named-hosts warnings in its output", () => {
		const output = [
			"  ✓  Postgres ready",
			"  \u001b[33m⚠\u001b[39m  Named URLs unavailable: the daemon on :443 stopped answering. Run `buncargo hosts install`.",
			"  api  http://localhost:3000",
		].join("\n");
		expect(namedHostsFallbacks(output)).toEqual([
			"Named URLs unavailable: the daemon on :443 stopped answering. Run `buncargo hosts install`.",
		]);
	});

	it("finds nothing when named hosts came up", () => {
		expect(namedHostsFallbacks("  api  https://api.app.localhost\n")).toEqual(
			[],
		);
	});
});

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
	async function detach(script: string) {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-detach-")));
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
			writeFileSync(join(root, "run.ts"), script);
			const code = await runDetached({
				root,
				expectApps: true,
				keep: false,
				argv: ["bun", join(root, "run.ts")],
				timeoutMs: 10_000,
			});
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
});

/**
 * `runDetached` in a process of its own over a stand-in run script, for the
 * failure paths: their last lines are written past Bun's stderr buffer, which
 * no console patch in this process sees.
 */
function detachInProcess(script: (root: string) => string) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-detach-")));
	try {
		const detach = join(import.meta.dir, "dev-detach.ts");
		writeFileSync(join(root, "run.ts"), script(root));
		writeFileSync(
			join(root, "parent.ts"),
			`import { runDetached } from ${JSON.stringify(detach)};
process.exitCode = await runDetached({
	root: ${JSON.stringify(root)},
	expectApps: true,
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
