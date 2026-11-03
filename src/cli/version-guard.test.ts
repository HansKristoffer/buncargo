import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockfileHash, writeInstallStamp } from "./install-stamp";
import { decideInstall, decideVersionGuard } from "./version-guard";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A repository whose package.json lists buncargo, and a CLI running from elsewhere. */
function project(installed?: { version: string; bin?: boolean }) {
	const root = mkdtempSync(join(tmpdir(), "buncargo-guard-"));
	dirs.push(root);
	mkdirSync(join(root, ".git"));
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ devDependencies: { buncargo: "^12.0.0" } }),
	);
	const running = join(root, "global");
	mkdirSync(running);
	if (installed) {
		const pkg = join(root, "node_modules", "buncargo");
		mkdirSync(join(pkg, "dist", "cli"), { recursive: true });
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({
				name: "buncargo",
				version: installed.version,
				bin: { buncargo: "./dist/cli/bin.js" },
			}),
		);
		if (installed.bin !== false)
			writeFileSync(join(pkg, "dist", "cli", "bin.js"), "");
	}
	return { root, running };
}

describe("decideVersionGuard", () => {
	it("hands over to an installed buncargo of another version, from a subdirectory too", () => {
		const { root, running } = project({ version: "12.6.0" });
		const app = join(root, "apps", "api");
		mkdirSync(app, { recursive: true });

		expect(
			decideVersionGuard(app, { version: "7.10.0", root: running }),
		).toEqual({
			kind: "reexec",
			entry: join(root, "node_modules", "buncargo", "dist", "cli", "bin.js"),
			version: "12.6.0",
		});
	});

	it("runs itself when the installed version matches", () => {
		const { root, running } = project({ version: "12.6.0" });
		expect(
			decideVersionGuard(root, { version: "12.6.0", root: running }),
		).toEqual({ kind: "run" });
	});

	it("runs itself when it is the installed package", () => {
		const { root } = project({ version: "12.6.0" });
		expect(
			decideVersionGuard(root, {
				version: "13.0.0",
				root: join(root, "node_modules", "buncargo"),
			}),
		).toEqual({ kind: "run" });
	});

	it("refuses a project that lists buncargo without installing it", () => {
		const { root, running } = project();
		expect(
			decideVersionGuard(root, { version: "7.10.0", root: running }),
		).toEqual({
			kind: "not-installed",
			packageJson: join(root, "package.json"),
			reason: "not installed",
		});
	});

	it("refuses an install whose CLI is missing", () => {
		const { root, running } = project({ version: "12.6.0", bin: false });
		expect(
			decideVersionGuard(root, { version: "7.10.0", root: running }).kind,
		).toBe("not-installed");
	});

	it("runs anywhere that is not a buncargo project", () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo-guard-"));
		dirs.push(root);
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
		expect(
			decideVersionGuard(root, { version: "7.10.0", root: "/nowhere" }),
		).toEqual({ kind: "run" });
	});
});

describe("decideInstall", () => {
	function at(path: string, secondsAgo: number) {
		const time = new Date(Date.now() - secondsAgo * 1000);
		utimesSync(path, time, time);
	}

	/** A monorepo root with bun.lock; buncargo is listed by one workspace. */
	function monorepo() {
		const root = mkdtempSync(join(tmpdir(), "buncargo-install-"));
		dirs.push(root);
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "mono" }));
		writeFileSync(join(root, "bun.lock"), "{}");
		const api = join(root, "apps", "api");
		mkdirSync(api, { recursive: true });
		writeFileSync(
			join(api, "package.json"),
			JSON.stringify({ devDependencies: { buncargo: "^15.0.0" } }),
		);
		return { root, api };
	}

	it("installs at the lockfile's directory when node_modules is missing", () => {
		const { root, api } = monorepo();
		expect(decideInstall(api)).toEqual({
			dir: root,
			reason: "node_modules is missing",
		});
	});

	it("installs when bun.lock changed after the last install", () => {
		const { root, api } = monorepo();
		mkdirSync(join(root, "node_modules"));
		writeInstallStamp(root, "an older lockfile");

		expect(decideInstall(api)?.reason).toBe(
			"node_modules is older than bun.lock",
		);

		writeInstallStamp(root, lockfileHash(root) ?? "");
		at(join(root, "node_modules"), 60);
		expect(decideInstall(api)).toBeUndefined();
	});

	it("trusts a hand-made install until bun.lock changes after it", () => {
		const { root, api } = monorepo();
		at(join(root, "bun.lock"), 60);
		mkdirSync(join(root, "node_modules"));
		expect(decideInstall(api)).toBeUndefined();

		at(join(root, "node_modules"), 120);
		expect(decideInstall(api)?.reason).toBe(
			"node_modules is older than bun.lock",
		);
	});

	it("leaves a project that does not list buncargo alone", () => {
		const { root } = monorepo();
		expect(decideInstall(root)).toBeUndefined();
	});

	it("leaves a project without bun.lock to the not-installed error", () => {
		const { root } = project();
		expect(decideInstall(root)).toBeUndefined();
	});
});
