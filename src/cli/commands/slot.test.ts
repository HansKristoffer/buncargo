import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseSlotArgs } from "./slot";

const cli = resolve(import.meta.dir, "../bin.ts");
const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

/** The CLI in a scratch home, outside CI, so it takes a real slot. */
function runSlot(args: string[], env: Record<string, string> = {}) {
	const home = mkdtempSync(join(tmpdir(), "buncargo-slot-home-"));
	homes.push(home);
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		...env,
	};
	for (const name of [
		"CI",
		"GITHUB_ACTIONS",
		"GITLAB_CI",
		"CIRCLECI",
		"JENKINS_URL",
	])
		delete childEnv[name];
	const result = Bun.spawnSync([process.execPath, cli, "slot", ...args], {
		cwd: tmpdir(),
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	return { ...result, home, stdout: result.stdout.toString() };
}

describe("parseSlotArgs", () => {
	it("takes the command after -- unchanged", () => {
		expect(parseSlotArgs(["--", "bun", "test", "--slot"])).toEqual({
			help: false,
			command: ["bun", "test", "--slot"],
			errors: [],
		});
	});

	it("rejects a missing command, unknown flags and stray arguments", () => {
		expect(parseSlotArgs([]).errors).toEqual(["Provide a command after --"]);
		expect(parseSlotArgs(["--app=api", "stray", "--", "x"]).errors).toEqual([
			"Unknown flag: --app=api",
			"Unexpected argument before --: stray",
		]);
	});
});

describe("buncargo slot", () => {
	it("runs the command with the shell's environment inside a slot, and passes its exit code on", () => {
		const result = runSlot(
			["--", "sh", "-c", 'echo "$OWN_VAR|$BUNCARGO_CHECK_SLOT"; exit 3'],
			{ OWN_VAR: "kept" },
		);

		expect(result.exitCode).toBe(3);
		const [ownVar, slot] = result.stdout.trim().split("|");
		expect(ownVar).toBe("kept");
		expect(slot).toBe(join(result.home, ".buncargo/check-slots/0.lock"));
		// Released once the command ended.
		expect(readdirSync(join(result.home, ".buncargo/check-slots"))).toEqual([]);
	});
});
