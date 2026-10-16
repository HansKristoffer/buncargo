import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideVersionGuard } from "./version-guard";

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
