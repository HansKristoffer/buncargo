import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installStampPath, writeInstallStamp } from "./install-stamp";

/**
 * A fresh worktree of a project that depends on buncargo, run through the real
 * version guard with the real `bun install`: the project's buncargo is a
 * local package, so nothing touches the network.
 */

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const GUARD = join(import.meta.dir, "version-guard.ts");

function checkout() {
	const base = mkdtempSync(join(tmpdir(), "buncargo-checkout-install-"));
	dirs.push(base);

	// The project's own buncargo: answers `status --json` with what it got.
	const installed = join(base, "project-buncargo");
	mkdirSync(installed);
	writeFileSync(
		join(installed, "package.json"),
		JSON.stringify({
			name: "buncargo",
			version: "99.0.0",
			bin: { buncargo: "bin.js" },
		}),
	);
	writeFileSync(
		join(installed, "bin.js"),
		"console.log(JSON.stringify({ ok: true, argv: process.argv.slice(2), from: process.env.BUNCARGO_REEXEC ?? null }));\n",
	);

	// Stands in for `bunx buncargo`: this checkout's guard, not run from src.
	const cli = join(base, "cli", "bin.ts");
	mkdirSync(join(base, "cli"));
	writeFileSync(
		cli,
		`import { guardVersion } from ${JSON.stringify(GUARD)};\nawait guardVersion(false);\nconsole.log(JSON.stringify({ ok: "not handed over" }));\n`,
	);

	// The worktree. Its postinstall runs buncargo, as gey-mono's does.
	const root = join(base, "worktree");
	mkdirSync(join(root, ".git"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "app",
			devDependencies: { buncargo: `file:${installed}` },
			scripts: {
				postinstall: `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} generate > postinstall.json`,
			},
		}),
	);
	const lock = Bun.spawnSync([process.execPath, "install", "--lockfile-only"], {
		cwd: root,
		stdout: "ignore",
		stderr: "pipe",
	});
	if (lock.exitCode !== 0) throw new Error(lock.stderr.toString());

	const run = (...args: string[]) => {
		const result = Bun.spawnSync([process.execPath, cli, ...args], {
			cwd: join(root),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	};
	return { root, run };
}

const INSTALLING = "running bun install --frozen-lockfile";

describe("a checkout installs itself", () => {
	it("runs `status --json` on the first call in a fresh worktree", () => {
		const { root, run } = checkout();

		const first = run("status", "--json");

		expect(first.exitCode).toBe(0);
		// stdout is the project's buncargo answering, and nothing else.
		expect(JSON.parse(first.stdout)).toEqual({
			ok: true,
			argv: ["status", "--json"],
			from: expect.any(String),
		});
		expect(first.stderr).toContain(
			`node_modules is missing in .; ${INSTALLING}`,
		);
		expect(existsSync(installStampPath(root))).toBe(true);
		// The postinstall's buncargo ran without installing again.
		expect(first.stderr.split(INSTALLING)).toHaveLength(2);
		expect(
			JSON.parse(readFileSync(join(root, "postinstall.json"), "utf8")),
		).toMatchObject({ ok: true, argv: ["generate"] });

		const second = run("status", "--json");
		expect(second.exitCode).toBe(0);
		expect(second.stderr).not.toContain(INSTALLING);
	});

	it("installs again once bun.lock changes, before a command that runs the project", () => {
		const { root, run } = checkout();
		expect(run("status").exitCode).toBe(0);

		// A branch switch rewrites bun.lock; touching it changes nothing.
		const later = new Date(Date.now() + 60_000);
		utimesSync(join(root, "bun.lock"), later, later);
		expect(run("exec", "--", "true").stderr).not.toContain(INSTALLING);

		writeInstallStamp(root, "another lockfile");
		// Teardown and read-only commands never reinstall under a running run.
		expect(run("stop", "--all").stderr).not.toContain(INSTALLING);
		const stale = run("exec", "--", "true");

		expect(stale.exitCode).toBe(0);
		expect(stale.stderr).toContain(
			`bun.lock changed since node_modules was installed in .; ${INSTALLING}`,
		);
		expect(run("exec", "--", "true").stderr).not.toContain(INSTALLING);
	});

	it("stops with the install's failure and the command to run", () => {
		const { root, run } = checkout();
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		pkg.devDependencies["left-pad"] = "1.3.0";
		writeFileSync(join(root, "package.json"), JSON.stringify(pkg));

		const failed = run("status", "--json");

		expect(failed.exitCode).not.toBe(0);
		expect(failed.stdout).toBe("");
		expect(failed.stderr).toContain("bun install --frozen-lockfile failed in");
		expect(failed.stderr).toContain("run `bun install` in");
	});

	it("never blocks stop on an install that would fail", () => {
		const { root, run } = checkout();
		expect(run("status").exitCode).toBe(0);
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		pkg.devDependencies["left-pad"] = "1.3.0";
		writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
		writeInstallStamp(root, "another lockfile");

		const stop = run("stop", "--all");

		expect(stop.exitCode).toBe(0);
		expect(stop.stderr).not.toContain(INSTALLING);
		expect(run("exec", "--", "true").exitCode).not.toBe(0);
	});
});
