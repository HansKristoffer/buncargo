import { afterEach, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "../test-env.testing";
import { inOwnUserScope } from "./user-scope";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir);
});

function userManager() {
	const dir = mkdtempSync(join(tmpdir(), "buncargo-user-scope-"));
	dirs.push(dir);
	mkdirSync(join(dir, "run", "systemd"), { recursive: true });
	writeFileSync(join(dir, "run", "systemd", "private"), "");
	mkdirSync(join(dir, "bin"));
	const systemdRun = join(dir, "bin", "systemd-run");
	writeFileSync(systemdRun, "#!/bin/sh\n");
	chmodSync(systemdRun, 0o755);
	return {
		systemdRun,
		env: { XDG_RUNTIME_DIR: join(dir, "run"), PATH: join(dir, "bin") },
	};
}

it("runs in a scope of its own under a Linux user manager", () => {
	const { env, systemdRun } = userManager();
	expect(inOwnUserScope(["bun", "x"], "test", env, "linux")).toEqual([
		systemdRun,
		"--user",
		"--scope",
		"--collect",
		"--quiet",
		"--description=test",
		"--",
		"bun",
		"x",
	]);
});

it("leaves the command alone elsewhere, without a user manager, or when turned off", () => {
	const { env } = userManager();
	const argv = ["bun", "x"];
	expect(inOwnUserScope(argv, "test", env, "darwin")).toEqual(argv);
	expect(
		inOwnUserScope(
			argv,
			"test",
			{ ...env, XDG_RUNTIME_DIR: "/nonexistent" },
			"linux",
		),
	).toEqual(argv);
	expect(inOwnUserScope(argv, "test", { ...env, PATH: "" }, "linux")).toEqual(
		argv,
	);
	expect(
		inOwnUserScope(
			argv,
			"test",
			{ ...env, BUNCARGO_SYSTEMD_SCOPE: "0" },
			"linux",
		),
	).toEqual(argv);
});
