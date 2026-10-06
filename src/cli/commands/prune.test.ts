import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execAsync } from "../../core/process";

const cli = [process.execPath, resolve(import.meta.dir, "../bin.ts")];

function git(cwd: string, ...args: string[]) {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) throw new Error(result.stderr);
}

/**
 * A main checkout `app`, a live worktree `feature` and a deleted one `gone`,
 * and a `docker` that lists what `listing/` holds and records every call.
 */
let base: string;
let main: string;
let fake: string;

beforeAll(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-prune-")));
	main = join(base, "app");
	mkdirSync(main);
	writeFileSync(join(main, "package.json"), JSON.stringify({ workspaces: [] }));
	writeFileSync(
		join(main, "dev.config.ts"),
		"export default {projectPrefix:'pp',services:{postgres:{port:5432}},apps:{}};",
	);
	git(main, "init", "-q");
	git(main, "add", ".");
	git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i");
	git(main, "worktree", "add", "-q", join(base, "feature"), "-b", "feature");
	git(main, "worktree", "add", "-q", join(base, "gone"), "-b", "gone");
	rmSync(join(base, "gone"), { recursive: true });

	fake = join(base, "docker");
	writeFileSync(
		fake,
		`#!/bin/sh
echo "$*" >> "${base}/calls"
case "$1 $2" in
  "ps -a") if [ -f "${base}/listing/listed" ] && [ -f "${base}/listing/containers.next" ]; then cat "${base}/listing/containers.next"; else touch "${base}/listing/listed"; cat "${base}/listing/containers"; fi ;;
  "rm "*) grep -qx "$2" "${base}/listing/refuse" 2>/dev/null && { echo "container is restarting" >&2; exit 1; } ;;
  "volume ls") [ -f "${base}/listing/fail" ] && { echo "daemon hung" >&2; exit 1; }; cat "${base}/listing/volumes" ;;
  "network ls") cat "${base}/listing/networks" ;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function listing(files: {
	containers?: string[];
	volumes?: string[];
	networks?: string[];
	fail?: boolean;
	/** What `ps` lists from its second call on: the state at removal. */
	containersNext?: string[];
	refuse?: string[];
}) {
	rmSync(join(base, "listing"), { recursive: true, force: true });
	rmSync(join(base, "calls"), { force: true });
	mkdirSync(join(base, "listing"));
	for (const kind of ["containers", "volumes", "networks"] as const)
		writeFileSync(
			join(base, "listing", kind),
			(files[kind] ?? []).map((line) => `${line}\n`).join(""),
		);
	if (files.fail) writeFileSync(join(base, "listing", "fail"), "");
	if (files.containersNext)
		writeFileSync(
			join(base, "listing", "containers.next"),
			files.containersNext.map((line) => `${line}\n`).join(""),
		);
	writeFileSync(
		join(base, "listing", "refuse"),
		(files.refuse ?? []).map((name) => `${name}\n`).join(""),
	);
}

const prune = (cwd: string, ...args: string[]) =>
	execAsync(
		[...cli, "prune", "--project", ...args],
		cwd,
		{
			HOME: join(base, "home"),
			BUNCARGO_CONTAINER_BINARY: fake,
			NO_COLOR: "1",
		},
		{ throwOnError: false },
	);

const removals = () =>
	readFileSync(join(base, "calls"), "utf-8")
		.split("\n")
		.filter((call) => / rm |^rm /.test(call));

describe("buncargo prune --project", () => {
	it("removes ci stacks and a deleted worktree's stacks, and keeps dev stacks, running stacks and other projects", async () => {
		listing({
			containers: [
				`c1\tpp-app-ci\texited\t${main}`,
				`c2\tpp-gone\texited\t${join(base, "gone")}`,
				`c3\tpp-feature-ci\trunning\t${join(base, "feature")}`,
				`c4\tpp-feature\texited\t${join(base, "feature")}`,
			],
			volumes: [
				"pp-app-ci_postgres-data\tpp-app-ci",
				"pp-gone_postgres-data\tpp-gone",
				"pp-gone-gone_postgres-data\tpp-gone-gone",
				"pp-feature-ci_postgres-data\tpp-feature-ci",
				"pp-feature_postgres-data\tpp-feature",
				"pp-app_postgres-data\tpp-app",
				"pp-app-other_postgres-data\tpp-app-other",
				"other-app-ci_postgres-data\tother-app-ci",
			],
			networks: ["pp-app-ci_default\tpp-app-ci"],
		});

		const dry = await prune(join(base, "feature"), "--dry-run");
		expect(dry.exitCode).toBe(0);
		expect(dry.stdout).toContain("Kept pp-feature-ci: a container is running");
		expect(removals()).toEqual([]);

		const result = await prune(main, "--yes");
		expect(result.exitCode).toBe(0);
		expect(removals()).toEqual([
			"rm c1",
			"volume rm pp-app-ci_postgres-data",
			"network rm pp-app-ci_default",
			"rm c2",
			"volume rm pp-gone_postgres-data",
			"volume rm pp-gone-gone_postgres-data",
		]);
	});

	it("removes nothing when the runtime's listing fails", async () => {
		listing({
			volumes: ["pp-app-ci_postgres-data\tpp-app-ci"],
			fail: true,
		});
		const result = await prune(main, "--yes");
		expect(result.exitCode).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain("daemon hung");
		expect(removals()).toEqual([]);
	});

	it("decides each stack again at removal: a container that started since the listing keeps it (round 1 F3)", async () => {
		listing({
			containers: [`c1\tpp-app-ci\texited\t${main}`],
			containersNext: [`c1\tpp-app-ci\trunning\t${main}`],
			volumes: ["pp-app-ci_postgres-data\tpp-app-ci"],
		});
		const result = await prune(main, "--yes");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			"Kept pp-app-ci: a container is running (stop it first).",
		);
		expect(removals()).toEqual([]);
	});

	it("keeps the rest of a stack when Docker refuses one of its containers (round 1 F3)", async () => {
		listing({
			containers: [
				`c1\tpp-app-ci\texited\t${main}`,
				`c2\tpp-gone\texited\t${join(base, "gone")}`,
			],
			volumes: [
				"pp-app-ci_postgres-data\tpp-app-ci",
				"pp-gone_postgres-data\tpp-gone",
			],
			refuse: ["c1"],
		});
		const result = await prune(main, "--yes");
		expect(result.exitCode).toBe(0);
		expect(removals()).toEqual([
			"rm c1",
			"rm c2",
			"volume rm pp-gone_postgres-data",
		]);
	});
});
