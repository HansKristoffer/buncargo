import { chmodSync } from "node:fs";
import type { ContainerRuntimeName } from "../types";
import { withFileLock } from "./file-lock";
import {
	defineListRegistry,
	isRouteOwnerAlive,
	type ListRegistryReadOptions,
} from "./registry-file";
import { chownToInvokingUser, stateFilePath } from "./state-paths";

/**
 * What is running on this machine right now.
 *
 * Nothing on disk answered that question. There were four partial signals and
 * no join between them: the watchdog heartbeat (a pid, under a hashed name you
 * had to know in advance), the hosts route registry (only projects with named
 * hosts, only HTTP services), the tunnel registry (only exposed targets), and
 * container labels (services but never apps, and a process spawn per read).
 * `buncargo ls` needed Docker just to say a project was up.
 *
 * So a run publishes itself here: identity, every app and service with its URL
 * and state, and the interpreter that started it. Written on start, patched as
 * apps come up, removed on teardown. Readers — `runs`, `stop`, the menu bar app
 * — need no config, no Docker and no git.
 *
 * The file mirrors the hosts route registry deliberately: same list-registry
 * primitive, same atomic temp-and-rename, same `withFileLock` around every
 * read-modify-write, same "prune anything whose owner pid is gone". Two
 * registries that behave differently under concurrency is a bug waiting for a
 * second terminal.
 */

const REGISTRY_VERSION = 1;
export const RUNS_FILENAME = "runs.json";

export type RunAppStatus =
	| "starting"
	| "ready"
	/** Served by a process this run did not spawn, so it also cannot stop it. */
	| "reused"
	| "failed"
	| "stopped";

export type RunServiceStatus = "starting" | "ready" | "stopped";

export interface RunAppEntry {
	name: string;
	port: number;
	/** The spawned dev server. Absent when the app was reused from another run. */
	pid?: number;
	/** Holds the TTY; stopping it tears the whole run down. */
	attached?: boolean;
	url: string;
	loopbackUrl: string;
	publicUrl?: string;
	hostname?: string;
	status: RunAppStatus;
}

export interface RunServiceEntry {
	name: string;
	/** Built-in preset, or absent for `service.custom()`. */
	preset?: string;
	port: number;
	url: string;
	loopbackUrl: string;
	publicUrl?: string;
	hostname?: string;
	tablePlusUrl?: string;
	/** What `stop` needs to reach the container without loading the config. */
	container?: { runtime: ContainerRuntimeName; name: string };
	status: RunServiceStatus;
}

export interface RunEntry {
	projectPrefix: string;
	projectName: string;
	root: string;
	/** Worktree directory name, or `null` in the main checkout. */
	worktree: string | null;
	branch?: string;
	/** The `buncargo dev` process. Its death retires the entry. */
	pid: number;
	startedAt: string;
	updatedAt: string;
	primaryApp?: string;
	hosts: { active: boolean; tld: string } | null;
	/**
	 * How to invoke this same buncargo again.
	 *
	 * A reader stopping one app must run the build that started it, not
	 * whatever `buncargo` resolves to in its own environment — in a worktree
	 * those are routinely different versions.
	 */
	cli: { program: string; script?: string };
	apps: RunAppEntry[];
	services: RunServiceEntry[];
}

export function getRunsPath(home?: string): string {
	return stateFilePath(RUNS_FILENAME, home);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isRunApp(value: unknown): value is RunAppEntry {
	if (!isRecord(value)) return false;
	return typeof value.name === "string" && typeof value.port === "number";
}

function isRunService(value: unknown): value is RunServiceEntry {
	if (!isRecord(value)) return false;
	return typeof value.name === "string" && typeof value.port === "number";
}

function isRunEntry(value: unknown): value is RunEntry {
	if (!isRecord(value)) return false;
	return (
		typeof value.projectName === "string" &&
		typeof value.root === "string" &&
		typeof value.pid === "number" &&
		Array.isArray(value.apps) &&
		value.apps.every(isRunApp) &&
		Array.isArray(value.services) &&
		value.services.every(isRunService)
	);
}

/**
 * The registry holds development database passwords — the compose defaults, or
 * whatever the repo's own config sets. `~/.buncargo` is the user's, but there
 * is no reason for the file to be world-readable.
 */
function secureFile(path: string): void {
	try {
		chmodSync(path, 0o600);
	} catch {
		// A mode we could not set is not worth failing a dev run over.
	}
	chownToInvokingUser(path);
}

const registry = defineListRegistry<RunEntry>({
	version: REGISTRY_VERSION,
	key: "runs",
	isEntry: isRunEntry,
	afterWrite: secureFile,
});

export async function loadRuns(
	path = getRunsPath(),
	options: ListRegistryReadOptions = {},
): Promise<RunEntry[]> {
	return registry.read(path, options);
}

/** Unlocked core, so callers already holding the lock can reuse it. */
async function prune(path: string): Promise<RunEntry[]> {
	const runs = await registry.read(path);
	const live = runs.filter((run) => isRouteOwnerAlive(run.pid));
	if (live.length !== runs.length) {
		await registry.write(path, live);
	}
	return live;
}

export async function pruneRuns(path = getRunsPath()): Promise<RunEntry[]> {
	return withFileLock(path, () => prune(path));
}

export type RunClaim = "take" | "keep" | "conflict";

/**
 * What an incoming run may do to the entry already holding its root.
 *
 * The same question `classifyRouteClaim` answers for hostnames, and it must be
 * answered the same way or the two registries disagree about who owns a
 * checkout. A second `buncargo dev` in the same directory is usually *reusing*
 * the first run's servers rather than replacing it, so it gets `keep` and the
 * live run stays the owner — which is what makes the entry disappear when the
 * run that owns the processes exits, not when a bystander does.
 *
 * A takeover is the case that must overwrite: same root, different pid, and
 * the old pid is gone by the time it registers, so it never reaches here.
 */
export function claimRun(existing: RunEntry, incoming: RunEntry): RunClaim {
	if (existing.pid === incoming.pid) return "take";
	if (!isRouteOwnerAlive(existing.pid)) return "take";
	if (existing.root !== incoming.root) return "conflict";
	return "keep";
}

export async function publishRun(
	run: RunEntry,
	options: { path?: string } = {},
): Promise<void> {
	const path = options.path ?? getRunsPath();
	await withFileLock(path, async () => {
		const runs = await prune(path);
		const index = runs.findIndex((entry) => entry.root === run.root);
		const existing = index >= 0 ? runs[index] : undefined;
		if (existing && claimRun(existing, run) === "keep") return;
		const next = [...runs];
		if (index >= 0) next[index] = run;
		else next.push(run);
		await registry.write(path, next);
	});
}

export interface RunPatch {
	apps?: Array<Partial<RunAppEntry> & { name: string }>;
	services?: Array<Partial<RunServiceEntry> & { name: string }>;
	hosts?: { active: boolean; tld: string } | null;
	primaryApp?: string;
}

function mergeByName<T extends { name: string }>(
	current: T[],
	updates: Array<Partial<T> & { name: string }>,
): T[] {
	const byName = new Map(current.map((entry) => [entry.name, entry]));
	for (const update of updates) {
		const existing = byName.get(update.name);
		// An update for something not in the run is dropped rather than
		// inserted: a half-populated entry would show in the UI as a real app.
		if (!existing) continue;
		byName.set(update.name, { ...existing, ...update });
	}
	return current.map((entry) => byName.get(entry.name) ?? entry);
}

/**
 * Update parts of a published run in place.
 *
 * Matched on root *and* pid: a run that has already been taken over must not
 * keep writing app states over the run that replaced it.
 */
export async function patchRun(
	root: string,
	pid: number,
	patch: RunPatch,
	options: { path?: string } = {},
): Promise<void> {
	const path = options.path ?? getRunsPath();
	await withFileLock(path, async () => {
		const runs = await registry.read(path);
		const index = runs.findIndex(
			(entry) => entry.root === root && entry.pid === pid,
		);
		const current = index >= 0 ? runs[index] : undefined;
		if (!current || index < 0) return;

		const next: RunEntry = {
			...current,
			updatedAt: new Date().toISOString(),
			...(patch.hosts !== undefined ? { hosts: patch.hosts } : {}),
			...(patch.primaryApp !== undefined
				? { primaryApp: patch.primaryApp }
				: {}),
			apps: patch.apps ? mergeByName(current.apps, patch.apps) : current.apps,
			services: patch.services
				? mergeByName(current.services, patch.services)
				: current.services,
		};
		const updated = [...runs];
		updated[index] = next;
		await registry.write(path, updated);
	});
}

/** Remove a run this process owns. A pid mismatch leaves the entry alone. */
export async function withdrawRun(
	root: string,
	pid: number,
	options: { path?: string } = {},
): Promise<void> {
	const path = options.path ?? getRunsPath();
	await withFileLock(path, async () => {
		const runs = await registry.read(path);
		const next = runs.filter(
			(entry) => !(entry.root === root && entry.pid === pid),
		);
		if (next.length !== runs.length) {
			await registry.write(path, next);
		}
	});
}

/** The live run for a checkout, or `undefined`. */
export async function findRunByRoot(
	root: string,
	path = getRunsPath(),
): Promise<RunEntry | undefined> {
	const runs = await pruneRuns(path);
	return runs.find((run) => run.root === root);
}

/** Runs grouped by project, main checkout first, then worktrees by start time. */
export function groupRunsByProject(runs: RunEntry[]): Map<string, RunEntry[]> {
	const groups = new Map<string, RunEntry[]>();
	for (const run of runs) {
		const key = run.projectPrefix || run.projectName;
		groups.set(key, [...(groups.get(key) ?? []), run]);
	}
	for (const [key, entries] of groups) {
		groups.set(
			key,
			[...entries].sort((a, b) => {
				if (!a.worktree && b.worktree) return -1;
				if (a.worktree && !b.worktree) return 1;
				return a.startedAt.localeCompare(b.startedAt);
			}),
		);
	}
	return groups;
}
