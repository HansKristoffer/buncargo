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
  "volume ls") [ -f "${base}/listing/fail" ] && { echo "daemon hung" >&2; exit 1; }
    echo >> "${base}/listing/volume-listings"
    if [ "$(wc -l < "${base}/listing/volume-listings")" -ge 3 ] && [ -f "${base}/listing/offsets.next" ]; then cp "${base}/listing/offsets.next" "$HOME/.buncargo/offsets.json"; fi
    cat "${base}/listing/volumes" ;;
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
	/**
	 * The `offsets.json` from the third `volume ls` on (the sweep's settling
	 * and the listing take the first two): the claims at removal.
	 */
	offsetsNext?: object;
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
	if (files.offsetsNext)
		writeFileSync(
			join(base, "listing", "offsets.next"),
			JSON.stringify(files.offsetsNext),
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

describe("buncargo prune", () => {
	const home = () => join(base, "home-machine");
	const offsetsPath = () => join(home(), ".buncargo", "offsets.json");
	const claim = (projectName: string, extra: object = {}) => ({
		offset: 100,
		ports: [5532],
		projectName,
		updatedAt: "2026-10-01T00:00:00.000Z",
		usedAt: "2026-10-01T00:00:00.000Z",
		...extra,
	});
	const claims = (entries: Record<string, object>) => ({
		version: 1,
		claims: entries,
	});
	/** `offsets.json` as `bytes`, or absent when undefined. */
	const writeOffsets = (bytes: string | undefined) => {
		rmSync(home(), { recursive: true, force: true });
		mkdirSync(join(home(), ".buncargo"), { recursive: true });
		if (bytes !== undefined) writeFileSync(offsetsPath(), bytes);
	};
	const machinePrune = (...args: string[]) =>
		execAsync(
			[...cli, "prune", ...args],
			base,
			{
				HOME: home(),
				BUNCARGO_CONTAINER_BINARY: fake,
				BUNCARGO_CONTAINER_RUNTIME: "docker",
				BUNCARGO_PRUNE_DELETED_CHECKOUTS: "0",
				NO_COLOR: "1",
			},
			{ throwOnError: false },
		);

	it("proposes a deleted checkout's volumes, and keeps every existing checkout's", async () => {
		listing({
			volumes: [
				"pp-app_postgres-data\tpp-app",
				"pp-feature_postgres-data\tpp-feature",
				"pp-app-ci_postgres-data\tpp-app-ci",
				"pp-gone_postgres-data\tpp-gone",
				"unclaimed_postgres-data\tunclaimed",
			],
		});
		// The sweep that runs first keeps `gone`'s claim while its project has
		// volumes: it is the only record of the project it used.
		writeOffsets(
			JSON.stringify(
				claims({
					[main]: claim("pp-app"),
					[join(base, "feature")]: claim("pp-feature"),
					[`${main}#ci`]: claim("pp-app-ci", { root: main, suffix: "ci" }),
					[join(base, "gone")]: claim("pp-gone"),
				}),
			),
		);

		const result = await machinePrune("--dry-run");

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("pp-gone_postgres-data  (pp-gone:");
		for (const kept of [
			"pp-app_postgres-data",
			"pp-feature_postgres-data",
			"pp-app-ci_postgres-data",
			"unclaimed_postgres-data",
		])
			expect(result.stdout).not.toContain(kept);
		expect(removals()).toEqual([]);
	});

	it("proposes with --older-than only the volumes of checkouts deleted that long ago", async () => {
		const daysAgo = (days: number) =>
			new Date(Date.now() - days * 86_400_000).toISOString();
		listing({
			volumes: [
				"pp-gone_postgres-data\tpp-gone",
				"pp-recent_postgres-data\tpp-recent",
			],
		});
		writeOffsets(
			JSON.stringify(
				claims({
					[join(base, "gone")]: claim("pp-gone", { deletedSeenAt: daysAgo(8) }),
					[join(base, "recent")]: claim("pp-recent", {
						deletedSeenAt: daysAgo(1),
					}),
				}),
			),
		);

		const result = await machinePrune("--older-than=7d", "--dry-run");

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("pp-gone_postgres-data  (pp-gone:");
		expect(result.stdout).not.toContain("pp-recent_postgres-data");

		const invalid = await machinePrune("--older-than=soon", "--dry-run");
		expect(invalid.exitCode).toBe(1);
		expect(invalid.stderr).toContain("--older-than expects an age");
	});

	it("proposes nothing when no claim names an idle checkout's volume", async () => {
		// An idle checkout has no container and no run: an unreadable claims
		// file read as empty made its database look orphaned.
		listing({ volumes: ["pp-app_postgres-data\tpp-app"] });
		writeOffsets(undefined);

		const result = await machinePrune("--yes");

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("No volumes to reclaim.");
		expect(removals()).toEqual([]);
	});

	it("removes nothing and leaves an unreadable claims file as it is", async () => {
		listing({ volumes: ["pp-gone_postgres-data\tpp-gone"] });
		writeOffsets("{ not json");

		const result = await machinePrune("--yes");

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("offsets.json could not be read");
		expect(readFileSync(offsetsPath(), "utf-8")).toBe("{ not json");
		expect(removals()).toEqual([]);
	});

	it("decides again under the lock after the prompt: a volume claimed since the listing is kept", async () => {
		const gone = join(base, "gone");
		const vanished = join(base, "vanished");
		const before = {
			[gone]: claim("pp-gone"),
			[vanished]: claim("pp-vanished"),
		};
		listing({
			volumes: [
				"pp-gone_postgres-data\tpp-gone",
				"pp-vanished_postgres-data\tpp-vanished",
			],
			// The main checkout took `pp-gone` between the listing and removal.
			offsetsNext: claims({ ...before, [main]: claim("pp-gone") }),
		});
		writeOffsets(JSON.stringify(claims(before)));

		const result = await machinePrune("--yes");

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			`Kept pp-gone_postgres-data: its checkout ${main} still exists.`,
		);
		expect(removals()).toEqual(["volume rm pp-vanished_postgres-data"]);
	});
});
