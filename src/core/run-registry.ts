import { chmodSync } from "node:fs";
import { basename } from "node:path";
import type { ContainerRuntimeName } from "../types";
import { buncargoCli, type CliInvocation } from "./cli-entry";
import type { ExpoAppIdentity } from "./expo";
import { withFileLock } from "./file-lock";
import { getWorktreeName } from "./ports";
import {
	processIdentityMatcher,
	readProcessIdentity,
} from "./process-identity";
import {
	defineListRegistry,
	type ListRegistryReadOptions,
} from "./registry-file";
import { chownToInvokingUser, stateFilePath } from "./state-paths";

/**
 * What is running on this machine right now.
 *
 * Nothing on disk answered that question. There were four partial signals and
 * no join between them: a per-project watchdog heartbeat (a pid, under a
 * hashed name you had to know in advance), the hosts route registry (only
 * projects with named hosts, only HTTP services), the tunnel registry (only
 * exposed targets), and container labels (services but never apps, and a
 * process spawn per read). `buncargo ls` needed Docker just to say a project
 * was up.
 *
 * This file is now the only one of those left for runs: the heartbeat folded
 * into it, so a run's liveness, its containers' idle hold and the backend
 * that started them are one record rather than two that could disagree.
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

/**
 * The `runs.json` schema. Bumping it makes every older BuncargoBar unable to
 * read the file, which is why `core/menubar.ts` compares it against the
 * installed bundle's `BuncargoRegistryVersion` and updates the app.
 */
export const REGISTRY_VERSION = 1;
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
	/** Transport used when sharing this endpoint through frp. */
	protocol?: "http" | "tcp";
	kind?: "server" | "worker";
	name: string;
	port?: number;
	/** The spawned dev server. Absent when the app was reused from another run. */
	pid?: number;
	processIdentity?: string;
	/** Holds the TTY; stopping it tears the whole run down. */
	attached?: boolean;
	url?: string;
	loopbackUrl?: string;
	publicUrl?: string;
	hostname?: string;
	/** Present on Expo apps: what `buncargo sim` needs without loading the config. */
	expo?: ExpoAppIdentity;
	status: RunAppStatus;
}

export interface RunServiceEntry {
	kind?: "service" | "job";
	protocol?: "http" | "tcp";
	name: string;
	/** Built-in preset, or absent for `service.custom()`. */
	preset?: string;
	port?: number;
	url?: string;
	loopbackUrl?: string;
	publicUrl?: string;
	hostname?: string;
	tablePlusUrl?: string;
	/** What `stop` needs to reach the container without loading the config. */
	container?: {
		runtime: ContainerRuntimeName;
		name: string;
		service?: string;
		binary?: string;
	};
	status: RunServiceStatus;
}

export interface RunEntry {
	/**
	 * Identifies this run; every write addresses an entry by it.
	 *
	 * Required: the entries that predated it were written by versions whose
	 * runs are long over, and dropping them on read is the clean swap.
	 */
	sessionId: string;
	processIdentity?: string;
	projectPrefix: string;
	projectName: string;
	root: string;
	/** Worktree directory name, or `null` in the main checkout. */
	worktree: string | null;
	branch?: string;
	/**
	 * The process that owns this run.
	 *
	 * Its death retires the entry — unless the run owns containers, which
	 * outlive it by design: then the entry survives, invisible to every
	 * "live runs" reader, until the sweep has torn the containers down.
	 * Never zeroed on release: the menu bar asks `kill(pid, 0)`, and pid 0
	 * is that app's own process group.
	 */
	pid: number;
	startedAt: string;
	updatedAt: string;
	/**
	 * When the owner exited on purpose, so its containers may be reused.
	 *
	 * Absent while the run is live. Set instead of withdrawing the entry,
	 * because a deliberate Ctrl-C has to be distinguishable from a crash: the
	 * crash grace is seconds, this hold is minutes, and without the
	 * distinction every restart paid for a container recreate.
	 */
	releasedAt?: string;
	/**
	 * When the sweep first found this run's owner gone without releasing.
	 *
	 * The crash grace is measured from here. Stamped once, by the sweep, so no
	 * live run pays for an accurate clock; `updatedAt` would not do, because a
	 * quiet run may not have written anything for hours before it crashed.
	 */
	ownerLostAt?: string;
	/**
	 * How long the containers are held after {@link RunEntry.releasedAt}.
	 *
	 * Absent means "as long as the checkout exists", which is what
	 * `--keep-containers` and the one-shot modes ask for.
	 */
	idleTimeoutMs?: number;
	primaryApp?: string;
	hosts: { active: boolean; tld: string } | null;
	/**
	 * How to invoke this same buncargo again.
	 *
	 * A reader stopping one app must run the build that started it, not
	 * whatever `buncargo` resolves to in its own environment — in a worktree
	 * those are routinely different versions.
	 */
	cli: CliInvocation;
	apps: RunAppEntry[];
	services: RunServiceEntry[];
}

export function getRunsPath(home?: string): string {
	return stateFilePath(RUNS_FILENAME, home);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPort(value: unknown): boolean {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value > 0 &&
		value <= 65535
	);
}
function isPid(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRunApp(value: unknown): value is RunAppEntry {
	if (!isRecord(value)) return false;
	return (
		typeof value.name === "string" &&
		(value.protocol === undefined ||
			value.protocol === "http" ||
			value.protocol === "tcp") &&
		(value.port !== undefined || value.kind === "worker") &&
		((value.port === undefined &&
			value.url === undefined &&
			value.loopbackUrl === undefined) ||
			(isPort(value.port) &&
				typeof value.url === "string" &&
				typeof value.loopbackUrl === "string")) &&
		["starting", "ready", "reused", "failed", "stopped"].includes(
			String(value.status),
		) &&
		(value.pid === undefined || isPid(value.pid)) &&
		(value.processIdentity === undefined ||
			typeof value.processIdentity === "string") &&
		(value.expo === undefined || isRecord(value.expo))
	);
}

function isRunService(value: unknown): value is RunServiceEntry {
	if (!isRecord(value)) return false;
	return (
		typeof value.name === "string" &&
		(value.protocol === undefined ||
			value.protocol === "http" ||
			value.protocol === "tcp") &&
		((value.port === undefined &&
			value.url === undefined &&
			value.loopbackUrl === undefined) ||
			(isPort(value.port) &&
				typeof value.url === "string" &&
				typeof value.loopbackUrl === "string")) &&
		["starting", "ready", "stopped"].includes(String(value.status)) &&
		(value.container === undefined ||
			(isRecord(value.container) &&
				["docker", "apple"].includes(String(value.container.runtime)) &&
				typeof value.container.name === "string" &&
				(value.container.binary === undefined ||
					typeof value.container.binary === "string") &&
				(value.container.service === undefined ||
					typeof value.container.service === "string")))
	);
}

function isRunEntry(value: unknown): value is RunEntry {
	if (!isRecord(value)) return false;
	return (
		typeof value.projectName === "string" &&
		typeof value.root === "string" &&
		isPid(value.pid) &&
		typeof value.sessionId === "string" &&
		(typeof value.processIdentity === "string" ||
			value.processIdentity === undefined) &&
		typeof value.projectPrefix === "string" &&
		typeof value.startedAt === "string" &&
		typeof value.updatedAt === "string" &&
		(value.releasedAt === undefined || typeof value.releasedAt === "string") &&
		(value.ownerLostAt === undefined ||
			typeof value.ownerLostAt === "string") &&
		(value.idleTimeoutMs === undefined ||
			(typeof value.idleTimeoutMs === "number" &&
				Number.isFinite(value.idleTimeoutMs))) &&
		isRecord(value.cli) &&
		typeof value.cli.program === "string" &&
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

/** Whether the process that published an entry is still running. */
export function isRunAlive(run: RunEntry): boolean {
	return runLiveness([run])(run);
}

/**
 * {@link isRunAlive} for a whole list, answered with one `ps`.
 *
 * The sweep asks this of every entry several times a tick. Asked one entry
 * at a time, each answer was a fork on macOS.
 */
export function runLiveness(
	runs: readonly RunEntry[],
): (run: RunEntry) => boolean {
	const matches = processIdentityMatcher(runs);
	return (run) =>
		run.releasedAt === undefined && matches(run.pid, run.processIdentity);
}

/**
 * Unlocked core, so callers already holding the lock can reuse it.
 *
 * A dead run that owns containers is *kept*. Its entry is the only record of
 * what those containers are for, which idle hold they were given and which
 * runtime started them, and the sweep needs all three to decide when to tear
 * them down. Every "what is running" reader filters on liveness anyway, so a
 * retired entry is invisible to `runs`, `stop` and the menu bar; only the
 * sweep sees it, and only the sweep removes it.
 */
async function prune(path: string): Promise<RunEntry[]> {
	const runs = await registry.read(path);
	const alive = runLiveness(runs);
	const kept = runs.filter((run) => alive(run) || run.services.length > 0);
	if (kept.length !== runs.length) {
		await registry.write(path, kept);
	}
	return kept;
}

/**
 * The entry a run starts from: who it is, where it is, and how to reach it.
 *
 * The one place an entry is constructed. The library claims with it before
 * the first container exists, and the CLI publishes the same shape enriched
 * with apps and hosts, so the two cannot drift on identity — or on how the
 * menu bar calls back into buncargo, which is where they once did.
 */
export function buildRunEntry(input: {
	sessionId: string;
	projectPrefix: string;
	projectName: string;
	root: string;
	isWorktree: boolean;
}): RunEntry {
	const now = new Date().toISOString();
	return {
		sessionId: input.sessionId,
		processIdentity: readProcessIdentity(process.pid),
		projectPrefix: input.projectPrefix,
		projectName: input.projectName,
		root: input.root,
		worktree: input.isWorktree
			? (getWorktreeName(input.root) ?? basename(input.root))
			: null,
		pid: process.pid,
		startedAt: now,
		updatedAt: now,
		hosts: null,
		cli: buncargoCli(),
		apps: [],
		services: [],
	};
}

/** Read, change and write the registry under its lock, skipping no-op writes. */
async function updateRuns(
	path: string,
	change: (runs: RunEntry[]) => RunEntry[] | undefined,
): Promise<void> {
	await withFileLock(path, async () => {
		const next = change(await registry.read(path));
		if (next) await registry.write(path, next);
	});
}

/**
 * Insert or update a session's entry.
 *
 * A session is published twice: the claim, before its containers start, and
 * then the CLI's richer entry. The second knows neither when the first
 * happened nor which hold it was claimed with, so both carry over.
 */
export async function publishRun(
	run: RunEntry,
	options: { path?: string } = {},
): Promise<void> {
	const path = options.path ?? getRunsPath();
	await withFileLock(path, async () => {
		const runs = await prune(path);
		const index = runs.findIndex((entry) => entry.sessionId === run.sessionId);
		const existing = runs[index];
		const next = [...runs];
		if (existing) {
			next[index] = {
				...run,
				startedAt: existing.startedAt,
				...(run.idleTimeoutMs === undefined &&
				existing.idleTimeoutMs !== undefined
					? { idleTimeoutMs: existing.idleTimeoutMs }
					: {}),
			};
		} else next.push(run);
		await registry.write(path, next);
	});
}

/**
 * Mark a session finished, keeping its containers for the hold.
 *
 * The first release wins. Teardown, the signal handler and `stop()` can all
 * reach this, and stamping it again each time pushed the hold later by
 * however long teardown took. A session with no services is removed instead:
 * there is nothing for the sweep to hold, and a dead row would show to
 * anything that forgot to filter.
 */
export async function releaseRun(
	sessionId: string,
	options: { path?: string } = {},
): Promise<void> {
	await updateRuns(options.path ?? getRunsPath(), (runs) => {
		const index = runs.findIndex((entry) => entry.sessionId === sessionId);
		const current = runs[index];
		if (!current || current.releasedAt !== undefined) return undefined;
		const next = [...runs];
		const now = new Date().toISOString();
		if (current.services.length === 0) next.splice(index, 1);
		// `updatedAt` too: the sweep takes the most recently active session as a
		// stack's owner, and a release is the latest thing this one did.
		else next[index] = { ...current, releasedAt: now, updatedAt: now };
		return next;
	});
}

/** Drop entries the sweep has finished with. */
export async function retireRuns(
	sessionIds: readonly string[],
	options: { path?: string } = {},
): Promise<void> {
	if (sessionIds.length === 0) return;
	const drop = new Set(sessionIds);
	await updateRuns(options.path ?? getRunsPath(), (runs) => {
		const next = runs.filter((entry) => !drop.has(entry.sessionId));
		return next.length === runs.length ? undefined : next;
	});
}

/**
 * Drop every entry for a checkout's project that has nothing left to hold.
 *
 * Called after an explicit teardown, which knows the containers are gone:
 * the caller's own session goes, and so does any whose owner has exited. A
 * live session in the same checkout keeps its entry — it is still somebody's
 * run, whatever just happened to the containers.
 */
export async function retireProjectRuns(
	target: { projectName: string; root: string; sessionId: string },
	options: { path?: string } = {},
): Promise<void> {
	await updateRuns(options.path ?? getRunsPath(), (runs) => {
		const alive = runLiveness(runs);
		const next = runs.filter(
			(entry) =>
				!(
					entry.projectName === target.projectName &&
					entry.root === target.root &&
					(entry.sessionId === target.sessionId || !alive(entry))
				),
		);
		return next.length === runs.length ? undefined : next;
	});
}

/**
 * Record when the sweep first found each session's owner gone.
 *
 * Only ever stamps an entry that has no stamp yet, so the grace keeps
 * counting from the first time it was noticed however many sweeps see it.
 */
export async function markOwnersLost(
	sessionIds: readonly string[],
	at: string,
	options: { path?: string } = {},
): Promise<void> {
	if (sessionIds.length === 0) return;
	const lost = new Set(sessionIds);
	await updateRuns(options.path ?? getRunsPath(), (runs) => {
		let changed = false;
		const next = runs.map((entry) => {
			if (!lost.has(entry.sessionId) || entry.ownerLostAt !== undefined)
				return entry;
			changed = true;
			return { ...entry, ownerLostAt: at };
		});
		return changed ? next : undefined;
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
		// Delayed readiness/PID publication must never resurrect a stopped app.
		const prior = existing as T & { status?: string };
		const incoming = update as Partial<T> & { status?: string };
		if (
			(prior.status === "stopped" || prior.status === "failed") &&
			(incoming.status === "ready" || incoming.status === "starting")
		)
			continue;
		byName.set(update.name, { ...existing, ...update });
	}
	return current.map((entry) => byName.get(entry.name) ?? entry);
}

/**
 * Update parts of a session's entry in place.
 *
 * Addressed by session alone: a takeover starts a new session rather than
 * adopting the old one, so a run that has been replaced can only ever write
 * to its own entry, never over its replacement's.
 */
export async function patchRun(
	sessionId: string,
	patch: RunPatch,
	options: { path?: string } = {},
): Promise<void> {
	await updateRuns(options.path ?? getRunsPath(), (runs) => {
		const index = runs.findIndex((entry) => entry.sessionId === sessionId);
		const current = runs[index];
		if (!current) return undefined;
		const next = [...runs];
		next[index] = {
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
		return next;
	});
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

/** Every independent live session using this checkout. */
export async function findRunsByRoot(
	root: string,
	path = getRunsPath(),
): Promise<RunEntry[]> {
	return (await readLiveRuns(path)).filter((run) => run.root === root);
}

/** Inspection filters stale owners in memory without mutating persisted state. */
export async function readLiveRuns(path = getRunsPath()): Promise<RunEntry[]> {
	const runs = await loadRuns(path, { strict: true });
	return runs.filter(runLiveness(runs));
}

/**
 * Every entry, live or retired, for the sweep.
 *
 * The only reader that wants the released ones: they are what says a stack
 * may still be reused, and for how much longer. Strict, so a registry that
 * cannot be read throws rather than reading as empty — to the sweep, an empty
 * registry would make every stack on the machine look unowned.
 */
export async function readAllRuns(path = getRunsPath()): Promise<RunEntry[]> {
	return loadRuns(path, { strict: true });
}
