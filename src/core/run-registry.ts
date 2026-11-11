import { basename } from "node:path";
import { isOneOf, isRecord, typedSwitch } from "hanzio";
import type { ExpoAppIdentity } from "../expo/app-identity";
import type { ContainerRuntimeName } from "../types";
import { buncargoCli, type CliInvocation } from "./cli-entry";
import { withFileLock } from "./file-lock";
import { getWorktreeName } from "./ports";
import { isProcessAlive } from "./process/lifecycle";
import {
	processIdentityMatcherAsync,
	readCurrentProcessIdentity,
	readCurrentProcessIdentityAsync,
	readProcessIdentitiesCached,
} from "./process-identity";
import {
	defineListRegistry,
	type ListRegistryReadOptions,
	readJsonDocumentSync,
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
const RUNS_FILENAME = "runs.json";

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
	/** What "open" opens for this app (`preferredAppUrl`), so every reader agrees. */
	openUrl?: string;
	hostname?: string;
	/** Present on Expo apps: what `buncargo expo sim` needs without loading the config. */
	expo?: ExpoAppIdentity;
	/** The exclusive lease this app holds (`AppConfig.exclusive`). */
	exclusive?: string;
	/** `AppConfig.stopGraceMs`: how long `stop` waits for it after SIGTERM. */
	stopGraceMs?: number;
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
	/** The integration stack providing it (see {@link RunEntry.stacks}); it has no container of ours. */
	stack?: string;
	/** What `stop` needs to reach the container without loading the config. */
	container?: {
		runtime: ContainerRuntimeName;
		name: string;
		service?: string;
		binary?: string;
	};
	status: RunServiceStatus;
	/**
	 * Set by the run when the container stopped, was removed or turned
	 * unhealthy under it, and cleared when it recovers. A separate field rather
	 * than a status: an older reader drops an entry whose status it does not
	 * know, and `status` stays what the run last set.
	 */
	problem?: RunServiceProblem;
}

export interface RunServiceProblem {
	state: "stopped" | "missing" | "unhealthy";
	/** The line the run printed: "postgres stopped (exit 0)", and who did it. */
	detail: string;
	since: string;
}

export interface RunStackEntry {
	name: string;
	/** argv, run from the checkout (or home once it is gone). Keeps data. */
	down: string[];
	/**
	 * The `com.docker.compose.project` label its containers carry. What stops
	 * them when `down` cannot run: a CLI that lived in a deleted checkout.
	 */
	composeProject?: string;
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
	/**
	 * The hold of an earlier run whose containers were held when this run,
	 * which asked for none (a library `start()`), claimed them. They come down
	 * this long after this run ends, released or exited, as they would have
	 * after the earlier one: without it the newest entry said "keep forever"
	 * and a one-second script pinned a CLI run's stack for days.
	 */
	inheritedIdleTimeoutMs?: number;
	primaryApp?: string;
	/**
	 * Started by `dev --detach`: no terminal shows its servers, so stopping it
	 * kills nothing anyone is watching and `stop` does not ask first.
	 */
	detached?: boolean;
	/**
	 * A detached run's idle limit: the watchdog stops it after this long with
	 * no request through buncargo's proxy and no buncargo command in its
	 * checkout (`core/run-limits.ts`). Absent for a run in a terminal, for
	 * `dev --detach --keep`, and for runs of a buncargo that had no limit.
	 */
	idleLimitMs?: number;
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
	/**
	 * Integration stacks (the Supabase CLI) this run started, with the command
	 * that stops each. The sweep runs it when it would tear the run's
	 * containers down: it has no config to ask.
	 */
	stacks?: RunStackEntry[];
	/** The config's tasks, which the menu bar runs with `buncargo run <name>`. */
	tasks?: RunTaskEntry[];
	/** Values apps printed (`captures`), by name: what `env --get captured.*` reads. */
	captures?: Record<string, string>;
	/** Labelled captures and integrations' `describe` values (e.g. "Shopify preview"). */
	details?: RunDetailEntry[];
}

export interface RunDetailEntry {
	label: string;
	value: string;
}

export interface RunTaskEntry {
	name: string;
	description?: string;
}

export function getRunsPath(): string {
	return stateFilePath(RUNS_FILENAME);
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
		isOneOf(
			["starting", "ready", "reused", "failed", "stopped"],
			value.status,
		) &&
		(value.pid === undefined || isPid(value.pid)) &&
		(value.processIdentity === undefined ||
			typeof value.processIdentity === "string") &&
		(value.expo === undefined || isRecord(value.expo)) &&
		(value.exclusive === undefined || typeof value.exclusive === "string") &&
		(value.stopGraceMs === undefined ||
			(typeof value.stopGraceMs === "number" && value.stopGraceMs > 0))
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
		isOneOf(["starting", "ready", "stopped"], value.status) &&
		(value.problem === undefined ||
			(isRecord(value.problem) &&
				typeof value.problem.state === "string" &&
				typeof value.problem.detail === "string")) &&
		(value.stack === undefined || typeof value.stack === "string") &&
		(value.container === undefined ||
			(isRecord(value.container) &&
				isOneOf(["docker", "apple"], value.container.runtime) &&
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
		(value.detached === undefined || typeof value.detached === "boolean") &&
		(value.idleLimitMs === undefined ||
			(typeof value.idleLimitMs === "number" && value.idleLimitMs > 0)) &&
		(value.idleTimeoutMs === undefined ||
			(typeof value.idleTimeoutMs === "number" &&
				Number.isFinite(value.idleTimeoutMs))) &&
		(value.inheritedIdleTimeoutMs === undefined ||
			(typeof value.inheritedIdleTimeoutMs === "number" &&
				Number.isFinite(value.inheritedIdleTimeoutMs))) &&
		isRecord(value.cli) &&
		typeof value.cli.program === "string" &&
		Array.isArray(value.apps) &&
		value.apps.every(isRunApp) &&
		Array.isArray(value.services) &&
		value.services.every(isRunService) &&
		(value.stacks === undefined ||
			(Array.isArray(value.stacks) &&
				value.stacks.every(
					(stack) =>
						isRecord(stack) &&
						typeof stack.name === "string" &&
						Array.isArray(stack.down) &&
						stack.down.length > 0 &&
						stack.down.every((arg) => typeof arg === "string"),
				))) &&
		(value.captures === undefined ||
			(isRecord(value.captures) &&
				Object.values(value.captures).every(
					(capture) => typeof capture === "string",
				))) &&
		(value.details === undefined ||
			(Array.isArray(value.details) &&
				value.details.every(
					(detail) =>
						isRecord(detail) &&
						typeof detail.label === "string" &&
						typeof detail.value === "string",
				))) &&
		(value.tasks === undefined ||
			(Array.isArray(value.tasks) &&
				value.tasks.every(
					(task) =>
						isRecord(task) &&
						typeof task.name === "string" &&
						(task.description === undefined ||
							typeof task.description === "string"),
				)))
	);
}

const registry = defineListRegistry<RunEntry>({
	version: REGISTRY_VERSION,
	key: "runs",
	isEntry: isRunEntry,
	afterWrite: chownToInvokingUser,
});

export async function loadRuns(
	options: ListRegistryReadOptions = {},
): Promise<RunEntry[]> {
	return registry.read(getRunsPath(), options);
}

/**
 * What `root`'s live runs captured, the newest run winning, read the way
 * `getEnvVar` inside a user's config can: synchronously and leniently, an
 * unreadable registry reading as no captures. Process identity is read once
 * per process for the runs it has not seen.
 */
export function readLiveCapturesSync(root: string): Record<string, string> {
	const runs = (
		readJsonDocumentSync(getRunsPath(), (value) =>
			isRecord(value) &&
			value.version === REGISTRY_VERSION &&
			Array.isArray(value.runs)
				? value.runs.filter(isRunEntry)
				: undefined,
		) ?? []
	).filter(
		(run) =>
			run.root === root &&
			run.releasedAt === undefined &&
			isProcessAlive(run.pid),
	);
	const identities = readProcessIdentitiesCached(
		runs.flatMap((run) => (run.processIdentity ? [run.pid] : [])),
	);
	const sameProcess = (run: RunEntry) => {
		const actual = identities.get(run.pid);
		return (
			run.processIdentity === undefined ||
			actual === undefined ||
			actual === run.processIdentity
		);
	};
	return Object.assign(
		{},
		...runs
			.filter(sameProcess)
			.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
			.map((run) => run.captures ?? {}),
	);
}

/**
 * Whether each entry's run is still going, answered with one `ps`.
 *
 * The sweep asks this of every entry several times a tick. Asked one entry
 * at a time, each answer was a fork on macOS. A released entry never reads
 * as live, whatever its pid.
 */
export async function runLivenessAsync(
	runs: readonly RunEntry[],
	signal?: AbortSignal,
): Promise<(run: RunEntry) => boolean> {
	const matches = await processIdentityMatcherAsync(runs, signal);
	return (run) =>
		run.releasedAt === undefined && matches(run.pid, run.processIdentity);
}

/**
 * The entries a publish keeps: a run whose process is gone and owns no
 * containers is dropped.
 *
 * A dead run that owns containers is *kept*. Its entry is the only record of
 * what those containers are for, which idle hold they were given and which
 * runtime started them, and the sweep needs all three to decide when to tear
 * them down. Every "what is running" reader filters on liveness anyway, so a
 * retired entry is invisible to `runs`, `stop` and the menu bar; only the
 * sweep sees it, and only the sweep removes it.
 *
 * Liveness here is `kill(pid, 0)` alone, asked under the registry's lock: no
 * `ps`, which forks on macOS. A pid some other process reuses keeps an entry
 * until the sweep, which compares identities, finds it gone.
 */
function prunedForPublish(runs: readonly RunEntry[]): RunEntry[] {
	return runs.filter(
		(run) =>
			run.services.length > 0 ||
			(run.releasedAt === undefined && isProcessAlive(run.pid)),
	);
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
	processIdentity?: string;
}): RunEntry {
	const now = new Date().toISOString();
	return {
		sessionId: input.sessionId,
		processIdentity:
			"processIdentity" in input
				? input.processIdentity
				: readCurrentProcessIdentity(),
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

export async function buildRunEntryAsync(
	input: Parameters<typeof buildRunEntry>[0],
	signal?: AbortSignal,
): Promise<RunEntry> {
	return buildRunEntry({
		...input,
		processIdentity: await readCurrentProcessIdentityAsync(signal),
	});
}

/**
 * Liveness of the registry's entries, read before its lock is taken: it forks
 * `ps`, and every run on the machine writes under that one lock, so a fork
 * inside it queued four starting runs for a second. An entry that is new since
 * this read, or now names another process, reads as alive, like a process
 * whose identity cannot be read.
 */
async function livenessBeforeLock(
	path: string,
): Promise<(run: RunEntry) => boolean> {
	const checked = await registry.read(path);
	const alive = await runLivenessAsync(checked);
	const bySession = new Map(checked.map((run) => [run.sessionId, run]));
	return (run) => {
		const seen = bySession.get(run.sessionId);
		const sameProcess =
			seen?.pid === run.pid && seen.processIdentity === run.processIdentity;
		return !sameProcess || alive(run);
	};
}

/** Read, change and write the registry under its lock, skipping no-op writes. */
async function updateRuns(
	path: string,
	change: (
		runs: RunEntry[],
	) => RunEntry[] | undefined | Promise<RunEntry[] | undefined>,
): Promise<void> {
	await withFileLock(path, () => registry.update(path, change));
}

/**
 * The two ways a session's own process writes its whole entry.
 *
 * - `claim`: the containers are this run's from now (`run-claim.ts`). It
 *   decides the lifecycle: the selected services, their stacks, the hold, and
 *   that the run is live again (no `releasedAt`, no `ownerLostAt`).
 * - `describe`: what the run serves (`run-publish.ts`): apps, hosts, URLs,
 *   tasks. It never touches the lifecycle, so a describe that lands after a
 *   release cannot reopen it, and it never drops what other writers recorded:
 *   app rows' processes and states, captures, a service's `problem`.
 */
export type RunPublishKind = "claim" | "describe";

/**
 * The entry a publish leaves, from the one it lands on.
 *
 * Every write of an entry is its owner's, so a publish clears `ownerLostAt`:
 * the owner is demonstrably alive.
 */
export function mergePublishedRun(
	existing: RunEntry | undefined,
	run: RunEntry,
	kind: RunPublishKind,
): RunEntry {
	if (!existing) return run;
	const { ownerLostAt: _lost, ...current } = existing;
	return typedSwitch(kind, {
		claim: (): RunEntry => {
			const {
				releasedAt: _released,
				idleTimeoutMs: _hold,
				inheritedIdleTimeoutMs: _inherited,
				stacks: _stacks,
				...kept
			} = current;
			// A claim reopening a finished entry (`releaseRun()`, then `start()`
			// again) starts a new run: ranking (`newestLifecycleFirst`) and the
			// claims a teardown releases date from it.
			const reopens =
				existing.releasedAt !== undefined || existing.ownerLostAt !== undefined;
			const stacks = mergedStacks(existing.stacks, run.stacks);
			return {
				...kept,
				...(reopens ? { startedAt: run.startedAt } : {}),
				sessionId: run.sessionId,
				processIdentity: run.processIdentity,
				projectPrefix: run.projectPrefix,
				projectName: run.projectName,
				root: run.root,
				worktree: run.worktree,
				pid: run.pid,
				updatedAt: run.updatedAt,
				cli: run.cli,
				// Exactly the claim's: one hold, or none.
				...holdFields(run),
				...(stacks === undefined ? {} : { stacks }),
				// The claim's selection, over what a describe said about each.
				services: run.services.map((service) => {
					const described = existing.services.find(
						(entry) => entry.name === service.name,
					);
					const { problem: _problem, ...rest } = described ?? service;
					return { ...rest, ...service };
				}),
			};
		},
		describe: (): RunEntry => ({
			...run,
			startedAt: current.startedAt,
			...holdFields(current),
			...(current.releasedAt === undefined
				? {}
				: { releasedAt: current.releasedAt }),
			...(current.stacks === undefined ? {} : { stacks: current.stacks }),
			...(current.captures === undefined ? {} : { captures: current.captures }),
			...(run.details === undefined && current.details !== undefined
				? { details: current.details }
				: {}),
			apps: run.apps.map((app) => describedApp(current.apps, app)),
			services: describedServices(current.services, run.services),
		}),
	});
}

/**
 * The stacks a claim leaves on its entry: every stack already recorded, which
 * may be standing in the idle hold, with the claim's own over any of the same
 * name. A claim that selects no stack must not drop one only this entry names.
 */
function mergedStacks(
	recorded: RunStackEntry[] | undefined,
	claimed: RunStackEntry[] | undefined,
): RunStackEntry[] | undefined {
	if (recorded === undefined) return claimed;
	if (claimed === undefined) return recorded;
	const names = new Set(claimed.map((stack) => stack.name));
	return [...recorded.filter((stack) => !names.has(stack.name)), ...claimed];
}

function holdFields(
	run: Pick<RunEntry, "idleTimeoutMs" | "inheritedIdleTimeoutMs">,
): Pick<RunEntry, "idleTimeoutMs" | "inheritedIdleTimeoutMs"> {
	if (run.idleTimeoutMs !== undefined)
		return { idleTimeoutMs: run.idleTimeoutMs };
	if (run.inheritedIdleTimeoutMs !== undefined)
		return { inheritedIdleTimeoutMs: run.inheritedIdleTimeoutMs };
	return {};
}

/**
 * A described app row over the one already there: the description is fresh,
 * the process and its state are what the spawner last reported. A reused app
 * has no process of this run's to keep.
 */
function describedApp(
	current: readonly RunAppEntry[],
	app: RunAppEntry,
): RunAppEntry {
	const previous = current.find((entry) => entry.name === app.name);
	if (!previous || app.status === "reused" || previous.status === "reused")
		return app;
	const keepsPublicUrl =
		app.publicUrl === undefined && previous.publicUrl !== undefined;
	return {
		...app,
		...(keepsPublicUrl
			? { publicUrl: previous.publicUrl, openUrl: previous.openUrl }
			: {}),
		...(previous.pid === undefined
			? {}
			: { pid: previous.pid, processIdentity: previous.processIdentity }),
		attached: app.attached ?? previous.attached,
		status: previous.status,
	};
}

/**
 * Described services over the claimed ones. Only a claim chooses which
 * services the entry holds, so a describe that lists fewer (an app-only
 * describe after the claim was released) keeps the rest: they are the
 * containers' record. A `problem` stays until the service watch clears it.
 */
function describedServices(
	current: readonly RunServiceEntry[],
	described: readonly RunServiceEntry[],
): RunServiceEntry[] {
	const merged = current.map((service) => {
		const update = described.find((entry) => entry.name === service.name);
		if (!update) return service;
		return {
			...service,
			...update,
			status: nextServiceStatus(service.status, update.status),
			...(service.problem === undefined ? {} : { problem: service.problem }),
		};
	});
	const added = described.filter(
		(entry) => !current.some((service) => service.name === entry.name),
	);
	return [...merged, ...added];
}

/**
 * Claim a session's entry: insert it, or make it the claim's over the one
 * already there (see {@link RunPublishKind}).
 */
export async function publishRun(run: RunEntry): Promise<void> {
	await publish(run, "claim");
}

/** Describe what a session serves, over its claim (see {@link RunPublishKind}). */
export async function describeRun(run: RunEntry): Promise<void> {
	await publish(run, "describe");
}

async function publish(run: RunEntry, kind: RunPublishKind): Promise<void> {
	await updateRuns(getRunsPath(), (runs) => {
		const next = prunedForPublish(runs);
		const index = next.findIndex((entry) => entry.sessionId === run.sessionId);
		const merged = mergePublishedRun(next[index], run, kind);
		if (index === -1) next.push(merged);
		else next[index] = merged;
		return next;
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
export async function releaseRun(sessionId: string): Promise<void> {
	await updateRuns(getRunsPath(), (runs) => {
		const index = runs.findIndex((entry) => entry.sessionId === sessionId);
		const current = runs[index];
		if (!current || current.releasedAt !== undefined) return undefined;
		const next = [...runs];
		const now = new Date().toISOString();
		if (current.services.length === 0) next.splice(index, 1);
		else next[index] = { ...current, releasedAt: now, updatedAt: now };
		return next;
	});
}

/**
 * When a session last changed state: released, found gone, or started.
 *
 * What "newest" means wherever one session has to speak for a stack (the
 * sweep's owner, {@link holdToInherit}). Not `updatedAt`, which every patch
 * moves: a dead session's service watch writing a `problem`, or an app
 * reporting ready, made it the stack's owner and its hold the stack's.
 */
function runLifecycleAt(
	run: Pick<RunEntry, "releasedAt" | "ownerLostAt" | "startedAt">,
): string {
	return run.releasedAt ?? run.ownerLostAt ?? run.startedAt;
}

/** Sort order for {@link runLifecycleAt}, newest first. */
export function newestLifecycleFirst(
	a: Pick<RunEntry, "releasedAt" | "ownerLostAt" | "startedAt">,
	b: Pick<RunEntry, "releasedAt" | "ownerLostAt" | "startedAt">,
): number {
	return runLifecycleAt(b).localeCompare(runLifecycleAt(a));
}

/**
 * The hold a run that asks for none takes over, when it is about to reuse a
 * stack another run left in its hold: the newest finished entry for the same
 * project and checkout that has one. Finished means released or found gone,
 * so the answer needs no liveness read (and no `ps`) on the start path.
 */
export function holdToInherit(
	runs: readonly RunEntry[],
	target: { projectName: string; root: string },
): number | undefined {
	// The newest decides: one that kept its containers on purpose
	// (`--keep-containers`) is not overruled by an older hold.
	const [newest] = runs
		.filter(
			(run) =>
				run.projectName === target.projectName &&
				run.root === target.root &&
				(run.releasedAt !== undefined || run.ownerLostAt !== undefined) &&
				run.services.length > 0,
		)
		.sort(newestLifecycleFirst);
	return newest?.idleTimeoutMs ?? newest?.inheritedIdleTimeoutMs;
}

type LifecycleFields = Pick<
	RunEntry,
	"sessionId" | "startedAt" | "releasedAt" | "ownerLostAt"
>;

/**
 * Whether an entry is still one of those read: it has not started again,
 * released or been found gone since. A session that released and claimed
 * again under the same id between a read and a write is live by then.
 */
function unchangedSince(
	read: readonly LifecycleFields[],
	current: RunEntry,
): boolean {
	const expected = read.find((entry) => entry.sessionId === current.sessionId);
	return (
		expected !== undefined &&
		expected.startedAt === current.startedAt &&
		expected.releasedAt === current.releasedAt &&
		expected.ownerLostAt === current.ownerLostAt
	);
}

/** Drop entries, each only while it is still the one that was read. */
export async function retireRuns(
	entries: readonly LifecycleFields[],
): Promise<void> {
	if (entries.length === 0) return;
	await updateRuns(getRunsPath(), (runs) => {
		const next = runs.filter((entry) => !unchangedSince(entries, entry));
		return next.length === runs.length ? undefined : next;
	});
}

/** A runtime, and the binary, a teardown took a project's containers down through. */
export type ContainerRuntimeRef = NonNullable<RunServiceEntry["container"]>;

function runtimeKey(ref: Pick<ContainerRuntimeRef, "runtime" | "binary">) {
	return `${ref.runtime}\0${ref.binary ?? ""}`;
}

/** Every runtime and binary an entry's containers were started through. */
export function recordedContainerRuntimes(
	run: Pick<RunEntry, "services">,
): ContainerRuntimeRef[] {
	const byKey = new Map<string, ContainerRuntimeRef>();
	for (const { container } of run.services)
		if (container && !byKey.has(runtimeKey(container)))
			byKey.set(runtimeKey(container), container);
	return [...byKey.values()];
}

/**
 * Whether a finished entry of a project holds nothing once a teardown of the
 * project came down on `downed`: every container it records was on one of
 * them. The one rule for retiring other sessions after a teardown, for
 * `stop` and a library `stop()` alike. A teardown that downed no runtime
 * (an app-only run's) retires nothing of anyone else's, and an entry of a
 * stack another runtime holds keeps it: retiring that would leave the stack
 * no owner record.
 */
export function heldOnlyOn(
	run: Pick<RunEntry, "services">,
	downed: readonly Pick<ContainerRuntimeRef, "runtime" | "binary">[],
): boolean {
	const keys = new Set(downed.map(runtimeKey));
	return (
		keys.size > 0 &&
		recordedContainerRuntimes(run).every((ref) => keys.has(runtimeKey(ref)))
	);
}

/**
 * Drop a session's entry after its explicit teardown, with the project's
 * finished entries that hold nothing afterwards ({@link heldOnlyOn}).
 *
 * A live session in the same checkout keeps its entry — it is still
 * somebody's run, whatever just happened to the containers.
 */
export async function retireProjectRuns(target: {
	projectName: string;
	root: string;
	sessionId: string;
	downed: readonly Pick<ContainerRuntimeRef, "runtime" | "binary">[];
}): Promise<void> {
	const alive = await livenessBeforeLock(getRunsPath());
	await updateRuns(getRunsPath(), (runs) => {
		const retired = (entry: RunEntry) =>
			entry.projectName === target.projectName &&
			entry.root === target.root &&
			(entry.sessionId === target.sessionId ||
				(!alive(entry) && heldOnlyOn(entry, target.downed)));
		const next = runs.filter((entry) => !retired(entry));
		return next.length === runs.length ? undefined : next;
	});
}

/**
 * Forget stacks the sweep has stopped, so the entry can retire like any other.
 * Only on an entry still the one that was read: a session that claimed again
 * meanwhile may have started those stacks again.
 */
export async function clearRunStacks(
	entries: readonly LifecycleFields[],
): Promise<void> {
	if (entries.length === 0) return;
	await updateRuns(getRunsPath(), (runs) => {
		let changed = false;
		const next = runs.map((entry) => {
			if (entry.stacks === undefined || !unchangedSince(entries, entry))
				return entry;
			changed = true;
			const { stacks: _stacks, ...rest } = entry;
			return rest;
		});
		return changed ? next : undefined;
	});
}

/**
 * Record when the sweep first found each session's owner gone, and forget it
 * for those whose owner it found running again.
 *
 * Only ever stamps an entry that has no stamp yet, so the grace keeps
 * counting from the first time it was noticed however many sweeps see it. A
 * stamp is cleared as soon as the owner reads as itself again: one wrong
 * "gone" (a `ps` that timed out) otherwise stayed for good, and
 * `holdToInherit` counted the live run as finished.
 */
export async function markOwnersLost(input: {
	lost: readonly string[];
	back: readonly string[];
	at: string;
}): Promise<void> {
	if (input.lost.length === 0 && input.back.length === 0) return;
	const lost = new Set(input.lost);
	const back = new Set(input.back);
	await updateRuns(getRunsPath(), (runs) => {
		let changed = false;
		const next = runs.map((entry) => {
			if (back.has(entry.sessionId) && entry.ownerLostAt !== undefined) {
				changed = true;
				const { ownerLostAt: _lost, ...rest } = entry;
				return rest;
			}
			if (!lost.has(entry.sessionId) || entry.ownerLostAt !== undefined)
				return entry;
			changed = true;
			return { ...entry, ownerLostAt: input.at };
		});
		return changed ? next : undefined;
	});
}

export type RunAppUpdate = Partial<RunAppEntry> & { name: string };

export interface RunPatch {
	/**
	 * Apps whose restart the run began: back to `starting` whatever their
	 * rows said, before the run replaces them. No status update can say it: a new
	 * pid on a running app is that app adopting its detached server, so a
	 * restarted app kept reading `ready`, and `restart && wait` returned on
	 * the process it had just replaced.
	 */
	restarting?: string[];
	apps?: RunAppUpdate[];
	services?: Array<Partial<RunServiceEntry> & { name: string }>;
	hosts?: { active: boolean; tld: string } | null;
	primaryApp?: string;
	/** Merged into the existing captures. */
	captures?: Record<string, string>;
	details?: RunDetailEntry[];
}

/**
 * An app row after one update from its run, or from `stop`.
 *
 * A new pid is a new process. On an ended row that is a restart, which starts
 * over; on a running one it is the app adopting a detached pid, which keeps
 * its state. Otherwise an ended row keeps how it ended: readiness reported
 * late never resurrects it, and `stopped` outranks `failed`, because `stop`
 * and the run both record an app's end after SIGTERM, and an app that exits
 * non-zero on SIGTERM was still stopped on purpose.
 */
export function nextAppRow(
	row: RunAppEntry,
	update: RunAppUpdate,
): RunAppEntry {
	const ended = row.status === "stopped" || row.status === "failed";
	const newProcess = update.pid !== undefined && update.pid !== row.pid;
	if (newProcess) {
		const fresh = ended ? "starting" : row.status;
		return { ...row, ...update, status: update.status ?? fresh };
	}
	return { ...row, ...update, status: nextAppStatus(row.status, update) };
}

function nextAppStatus(
	current: RunAppStatus,
	update: RunAppUpdate,
): RunAppStatus {
	const incoming = update.status;
	if (incoming === undefined) return current;
	return typedSwitch(current, {
		stopped: () => current,
		failed: () => (incoming === "stopped" ? incoming : current),
		starting: () => incoming,
		ready: () => incoming,
		reused: () => incoming,
	});
}

function mergeApps(
	current: RunAppEntry[],
	patch: Pick<RunPatch, "apps" | "restarting">,
): RunAppEntry[] {
	const restarting = new Set(patch.restarting);
	return current.map((row) => {
		const restarted =
			restarting.has(row.name) && row.status !== "reused"
				? { ...row, status: "starting" as const }
				: row;
		// An update for an app not in the run is dropped rather than inserted:
		// a half-populated entry would show in the UI as a real app.
		return (patch.apps ?? [])
			.filter((update) => update.name === row.name)
			.reduce(nextAppRow, restarted);
	});
}

/**
 * A service row's status after an update. Its states are written after the
 * fact (`ready` once the containers were waited for, `stopped` once `stop` did
 * it), except that `ready` never undoes `stopped`: a describe defaults every
 * row to `ready`, and the run's readiness report is queued, so either could
 * land after `buncargo stop <service>`. A run that starts the service again
 * marks it `starting` first (or claims afresh), which leaves `stopped`.
 */
function nextServiceStatus(
	current: RunServiceStatus,
	incoming: RunServiceStatus | undefined,
): RunServiceStatus {
	if (incoming === undefined) return current;
	if (current === "stopped" && incoming === "ready") return current;
	return incoming;
}

function mergeServices(
	current: RunServiceEntry[],
	updates: Array<Partial<RunServiceEntry> & { name: string }>,
): RunServiceEntry[] {
	return current.map((service) => {
		let row = service;
		for (const update of updates)
			if (update.name === service.name)
				row = {
					...row,
					...update,
					status: nextServiceStatus(row.status, update.status),
				};
		return row;
	});
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
): Promise<void> {
	await patchRunBatch(sessionId, [patch]);
}

/** Apply ordered updates under one lock, including terminal-state protections. */
export async function patchRunBatch(
	sessionId: string,
	patches: readonly RunPatch[],
): Promise<void> {
	if (patches.length === 0) return;
	await updateRuns(getRunsPath(), (runs) => {
		const index = runs.findIndex((entry) => entry.sessionId === sessionId);
		const current = runs[index];
		if (!current) return undefined;
		const next = [...runs];
		next[index] = patches.reduce(applyRunPatch, current);
		return next;
	});
}

function applyRunPatch(current: RunEntry, patch: RunPatch): RunEntry {
	return {
		...current,
		updatedAt: new Date().toISOString(),
		...(patch.hosts !== undefined ? { hosts: patch.hosts } : {}),
		...(patch.primaryApp !== undefined ? { primaryApp: patch.primaryApp } : {}),
		...(patch.captures
			? { captures: { ...current.captures, ...patch.captures } }
			: {}),
		...(patch.details ? { details: patch.details } : {}),
		apps: mergeApps(current.apps, patch),
		services: patch.services
			? mergeServices(current.services, patch.services)
			: current.services,
	};
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
export async function findRunsByRoot(root: string): Promise<RunEntry[]> {
	return (await readLiveRuns()).filter((run) => run.root === root);
}

/**
 * A checkout's live sessions, and its finished ones whose services may still
 * stand: released into the idle hold, or crashed. Those are what `stop` can
 * still take down, though no reader that filters live entries shows them.
 */
export async function findCheckoutRuns(
	root: string,
): Promise<{ live: RunEntry[]; held: RunEntry[] }> {
	return readCheckoutRuns((run) => run.root === root);
}

/**
 * {@link findCheckoutRuns} for every entry `select` keeps, with one liveness
 * read: what a full port range asks of every claim's checkout at once.
 */
export async function readCheckoutRuns(
	select: (run: RunEntry) => boolean,
): Promise<{ live: RunEntry[]; held: RunEntry[] }> {
	const runs = (await loadRuns({ strict: true })).filter(select);
	const alive = await runLivenessAsync(runs);
	return {
		live: runs.filter(alive),
		held: runs.filter((run) => !alive(run) && run.services.length > 0),
	};
}

/** Inspection filters stale owners in memory without mutating persisted state. */
export async function readLiveRuns(): Promise<RunEntry[]> {
	const runs = await loadRuns({ strict: true });
	return runs.filter(await runLivenessAsync(runs));
}

/**
 * Every entry, live or retired, for the sweep.
 *
 * The only reader that wants the released ones: they are what says a stack
 * may still be reused, and for how much longer. Strict, so a registry that
 * cannot be read throws rather than reading as empty — to the sweep, an empty
 * registry would make every stack on the machine look unowned.
 */
export async function readAllRuns(): Promise<RunEntry[]> {
	return loadRuns({ strict: true });
}
