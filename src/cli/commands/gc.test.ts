import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
import { REGISTRY_VERSION, type RunEntry } from "../../core/run-registry";
import { runEntry } from "../../core/run-registry.testing";
import { removeTempDir } from "../../core/test-env.testing";
import { dockerListLine } from "../../docker/fake-docker.testing";
import type { GcJson } from "../json-documents";

const cli = [process.execPath, resolve(import.meta.dir, "../bin.ts")];

let base: string;
let existing: string;
let idleWorktree: string;
let goneWorktree: string;
let goneNoVolumes: string;
let fakeDocker: string;

beforeAll(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-gc-")));
	existing = join(base, "existing");
	idleWorktree = join(base, "idle-wt");
	goneWorktree = join(base, "gone-wt");
	goneNoVolumes = join(base, "gone-clean");
	mkdirSync(existing);
	mkdirSync(idleWorktree);

	fakeDocker = join(base, "docker");
	writeFileSync(
		fakeDocker,
		`#!/bin/sh
echo "$*" >> "${base}/calls"
case "$1 $2" in
  "info "*) exit 0 ;;
  "ps --all"|"ps -a")
    if [ -f "${base}/state/downed" ]; then
      grep -v -F -f "${base}/state/downed" "${base}/state/containers" 2>/dev/null || true
    else
      cat "${base}/state/containers"
    fi ;;
  "compose "*)
    for arg in "$@"; do
      if [ "$prev" = "-p" ]; then
        echo "$arg" >> "${base}/state/downed"
      fi
      prev="$arg"
    done ;;
  "volume ls")
    if [ -f "${base}/state/removed-volumes" ]; then
      grep -v -F -f "${base}/state/removed-volumes" "${base}/state/volumes" 2>/dev/null || true
    else
      cat "${base}/state/volumes"
    fi ;;
  "volume rm")
    shift 2
    for vol in "$@"; do
      echo "$vol" >> "${base}/state/removed-volumes"
    done ;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
});

afterAll(() => removeTempDir(base));

function setupState(input: {
	containers?: string[];
	volumes?: string[];
	claims?: Record<string, object> | string;
	runs?: RunEntry[];
}) {
	const home = join(base, "home");
	rmSync(home, { recursive: true, force: true });
	rmSync(join(base, "state"), { recursive: true, force: true });
	rmSync(join(base, "calls"), { force: true });
	mkdirSync(join(home, ".buncargo"), { recursive: true });
	mkdirSync(join(base, "state"), { recursive: true });

	writeFileSync(
		join(base, "state", "containers"),
		(input.containers ?? []).map((line) => `${line}\n`).join(""),
	);
	writeFileSync(
		join(base, "state", "volumes"),
		(input.volumes ?? []).map((line) => `${line}\n`).join(""),
	);
	if (typeof input.claims === "string") {
		writeFileSync(join(home, ".buncargo", "offsets.json"), input.claims);
	} else if (input.claims) {
		writeFileSync(
			join(home, ".buncargo", "offsets.json"),
			JSON.stringify({ version: 1, claims: input.claims }),
		);
	}
	if (input.runs) {
		writeFileSync(
			join(home, ".buncargo", "runs.json"),
			JSON.stringify({ version: REGISTRY_VERSION, runs: input.runs }),
		);
	}
	return home;
}

function claim(
	projectName: string,
	offset: number,
	usedAt: string,
	extra: Record<string, unknown> = {},
) {
	return {
		offset,
		ports: [5432 + offset],
		projectName,
		updatedAt: usedAt,
		usedAt,
		...extra,
	};
}

function runGc(
	home: string,
	args: string[],
	extraEnv: Record<string, string> = {},
) {
	return execAsync(
		[...cli, "gc", ...args],
		base,
		{
			HOME: home,
			BUNCARGO_CONTAINER_BINARY: fakeDocker,
			BUNCARGO_CONTAINER_RUNTIME: "docker",
			BUNCARGO_PRUNE_DELETED_CHECKOUTS: "0",
			NO_COLOR: "1",
			...extraEnv,
		},
		{ throwOnError: false },
	);
}

describe("buncargo gc", () => {
	const oldIso = new Date(Date.now() - 4 * 3_600_000).toISOString();
	const recentIso = new Date(Date.now() - 5 * 60_000).toISOString();

	function fixture() {
		return setupState({
			containers: [
				dockerListLine({
					id: "c-existing",
					project: "gc-existing",
					service: "db",
					state: "running",
					status: "Up 5m",
					root: existing,
				}),
				dockerListLine({
					id: "c-idle",
					project: "gc-idle",
					service: "db",
					state: "running",
					status: "Up 4h",
					root: idleWorktree,
				}),
				dockerListLine({
					id: "c-gone",
					project: "gc-gone",
					service: "db",
					state: "running",
					status: "Up 4h",
					root: goneWorktree,
				}),
			],
			volumes: [
				"gc-existing_pg\tgc-existing",
				"gc-idle_pg\tgc-idle",
				"gc-gone_pg\tgc-gone",
			],
			claims: {
				[existing]: claim("gc-existing", 100, recentIso),
				[idleWorktree]: claim("gc-idle", 200, oldIso),
				[goneWorktree]: claim("gc-gone", 300, oldIso),
				[goneNoVolumes]: claim("gc-gone-clean", 400, oldIso),
			},
		});
	}

	it("previews everything with --dry-run --json without mutating containers, volumes or offsets.json", async () => {
		const home = fixture();
		const offsetsBefore = readFileSync(
			join(home, ".buncargo", "offsets.json"),
			"utf8",
		);

		const result = await runGc(home, ["--dry-run", "--json"]);

		expect(result.exitCode).toBe(0);
		const doc = JSON.parse(result.stdout) as GcJson;
		expect(Object.keys(doc).sort()).toEqual([
			"claims",
			"dryRun",
			"failed",
			"skippedVolumes",
			"stacks",
			"volumes",
		]);
		expect(doc.dryRun).toBe(true);
		expect(doc.stacks.map((s) => s.projectName).sort()).toEqual([
			"gc-gone",
			"gc-idle",
		]);
		expect(doc.volumes.map((v) => v.name)).toEqual(["gc-gone_pg"]);
		expect(doc.claims.map((c) => c.key).sort()).toEqual(
			[goneNoVolumes, goneWorktree].sort(),
		);
		expect(readFileSync(join(home, ".buncargo", "offsets.json"), "utf8")).toBe(
			offsetsBefore,
		);
		const calls = readFileSync(join(base, "calls"), "utf8");
		expect(calls).not.toContain("compose ");
		expect(calls).not.toContain("volume rm");
	});

	it("stops orphaned stacks, removes deleted-checkout volumes and prunes stale claims with --yes", async () => {
		const home = fixture();

		const result = await runGc(home, ["--yes", "--json"]);

		expect(result.exitCode).toBe(0);
		const doc = JSON.parse(result.stdout) as GcJson;
		expect(doc.dryRun).toBe(false);
		expect(doc.stacks.map((s) => s.projectName).sort()).toEqual([
			"gc-gone",
			"gc-idle",
		]);
		expect(doc.volumes).toMatchObject([{ name: "gc-gone_pg", removed: true }]);
		expect(doc.claims.map((c) => c.key).sort()).toEqual(
			[goneNoVolumes, goneWorktree].sort(),
		);
		expect(doc.failed).toEqual([]);

		// Existing checkouts' claims stay; deleted checkouts' claims are gone.
		const offsetsAfter = JSON.parse(
			readFileSync(join(home, ".buncargo", "offsets.json"), "utf8"),
		) as { claims: Record<string, unknown> };
		expect(Object.keys(offsetsAfter.claims).sort()).toEqual(
			[existing, idleWorktree].sort(),
		);

		// Existing idle worktree's database volume was never removed.
		const removedVols = readFileSync(
			join(base, "state", "removed-volumes"),
			"utf8",
		).trim();
		expect(removedVols).toBe("gc-gone_pg");
	});

	it("keeps deleted-checkout volumes and their claims when run non-interactively without --yes", async () => {
		const home = fixture();

		const result = await runGc(home, ["--json"]);

		expect(result.exitCode).toBe(0);
		const doc = JSON.parse(result.stdout) as GcJson;
		expect(doc.stacks.map((s) => s.projectName).sort()).toEqual([
			"gc-gone",
			"gc-idle",
		]);
		expect(doc.skippedVolumes).toBe(1);
		expect(doc.volumes).toMatchObject([{ name: "gc-gone_pg", removed: false }]);
		// The deleted checkout with no volumes is pruned; the one with a kept
		// volume keeps its claim so a later `gc --yes` or `prune` can still find it.
		expect(doc.claims.map((c) => c.key)).toEqual([goneNoVolumes]);
	});

	it("fails with exit 1 and touches nothing when offsets.json is unreadable", async () => {
		const home = setupState({ claims: "{ corrupt" });

		const result = await runGc(home, ["--yes"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("offsets.json could not be read");
		expect(readFileSync(join(home, ".buncargo", "offsets.json"), "utf8")).toBe(
			"{ corrupt",
		);
	});

	it("removes stack, volume and claim in one pass when a deleted checkout has a dead runs.json entry", async () => {
		const home = setupState({
			containers: [
				dockerListLine({
					id: "c-gone",
					project: "gc-gone",
					service: "db",
					state: "running",
					status: "Up 4h",
					root: goneWorktree,
				}),
			],
			volumes: ["gc-gone_pg\tgc-gone"],
			claims: { [goneWorktree]: claim("gc-gone", 300, oldIso) },
			runs: [
				runEntry({
					sessionId: "dead-gone",
					projectName: "gc-gone",
					root: goneWorktree,
					pid: 1,
					services: [{ name: "db", status: "ready" }],
				}),
			],
		});

		const dry = await runGc(home, ["--dry-run", "--json"]);
		expect(dry.exitCode).toBe(0);
		const dryDoc = JSON.parse(dry.stdout) as GcJson;
		expect(dryDoc.stacks.map((s) => s.projectName)).toEqual(["gc-gone"]);
		expect(dryDoc.volumes.map((v) => v.name)).toEqual(["gc-gone_pg"]);
		expect(dryDoc.claims.map((c) => c.key)).toEqual([goneWorktree]);

		const live = await runGc(home, ["--yes", "--json"]);
		expect(live.exitCode).toBe(0);
		const liveDoc = JSON.parse(live.stdout) as GcJson;
		expect(liveDoc.stacks.map((s) => s.projectName)).toEqual(["gc-gone"]);
		expect(liveDoc.volumes).toMatchObject([
			{ name: "gc-gone_pg", removed: true },
		]);
		expect(liveDoc.claims.map((c) => c.key)).toEqual([goneWorktree]);
	});

	it("reports volumes settled under BUNCARGO_PRUNE_DELETED_CHECKOUTS=1 without bypassing --yes for newly deleted checkouts", async () => {
		const settledGone = join(base, "settled-gone");
		const freshGone = join(base, "fresh-gone");
		const home = setupState({
			volumes: ["gc-settled_pg\tgc-settled", "gc-fresh_pg\tgc-fresh"],
			claims: {
				[settledGone]: claim("gc-settled", 300, oldIso, {
					deletedSeenAt: oldIso,
				}),
				[freshGone]: claim("gc-fresh", 400, oldIso),
			},
		});

		const result = await runGc(home, ["--json"], {
			BUNCARGO_PRUNE_DELETED_CHECKOUTS: "1",
		});

		expect(result.exitCode).toBe(0);
		const doc = JSON.parse(result.stdout) as GcJson;
		expect(doc.volumes).toContainEqual(
			expect.objectContaining({ name: "gc-settled_pg", removed: true }),
		);
		expect(doc.volumes).toContainEqual(
			expect.objectContaining({ name: "gc-fresh_pg", removed: false }),
		);
		expect(doc.skippedVolumes).toBe(1);
		expect(doc.claims.map((c) => c.key)).toEqual([settledGone]);
	});
});
