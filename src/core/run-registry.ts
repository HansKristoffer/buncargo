import { basename } from "node:path";
import { isBoolean, isOneOf, isRecord, isString, typedSwitch } from "hanzio";
import { buncargoCli } from "./cli-entry";
import { withFileLock } from "./file-lock";
import {
	arrayOf,
	type Guarded,
	isFiniteNumber,
	isPort,
	isPositiveInteger,
	nullable,
	object,
	oneOf,
	optional,
	recordOf,
	refine,
} from "./json-shape";
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
	StateFileUnreadableError,
	StateFileVersionError,
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
export const REGISTRY_VERSION = 2;
const RUNS_FILENAME = "runs.json";

const isProtocol = isOneOf(["http", "tcp"]);

/** An endpoint has a port and both URLs, or none of the three. */
function endpointComplete(row: {
	port?: number;
	url?: string;
	loopbackUrl?: string;
}): boolean {
	const fields = [row.port, row.url, row.loopbackUrl];
	return (
		fields.every((field) => field === undefined) ||
		fields.every((field) => field !== undefined)
	);
}

const isRunApp = refine(
	object({
		/** Transport used when sharing this endpoint through frp. */
		protocol: optional(isProtocol),
		kind: optional(isOneOf(["server", "worker"])),
		name: isString,
		port: optional(isPort),
		/** The spawned dev server. Absent when the app was reused from another run. */
		pid: optional(isPositiveInteger),
		processIdentity: optional(isString),
		/** Holds the TTY; stopping it tears the whole run down. */
		attached: optional(isBoolean),
		url: optional(isString),
		loopbackUrl: optional(isString),
		publicUrl: optional(isString),
		/** What "open" opens for this app (`preferredAppUrl`), so every reader agrees. */
		openUrl: optional(isString),
		hostname: optional(isString),
		/**
		 * What each integration's `describeApp` recorded, by integration name
		 * (`integrations.expo` is what `buncargo expo sim` and BuncargoBar read).
		 * Its own key, so an integration cannot overwrite `pid` or `status`.
		 */
		integrations: optional(recordOf(isRecord)),
		/** The exclusive lease this app holds (`AppConfig.exclusive`). */
		exclusive: optional(isString),
		/** `AppConfig.stopGraceMs`: how long `stop` waits for it after SIGTERM. */
		stopGraceMs: optional(refine(isFiniteNumber, (ms) => ms > 0)),
		/** `reused`: served by a process this run did not spawn, so it cannot stop it either. */
		status: isOneOf(["starting", "ready", "reused", "failed", "stopped"]),
	}),
	(app) =>
		endpointComplete(app) && (app.port !== undefined || app.kind === "worker"),
);

const isRunServiceProblem = object({
	state: isOneOf(["stopped", "missing", "unhealthy"]),
	/** The line the run printed: "postgres stopped (exit 0)", and who did it. */
	detail: isString,
	since: isString,
});

const isRunService = refine(
	object({
		kind: optional(isOneOf(["service", "job"])),
		protocol: optional(isProtocol),
		name: isString,
		/** Built-in preset, or absent for `service.custom()`. */
		preset: optional(isString),
		port: optional(isPort),
		url: optional(isString),
		loopbackUrl: optional(isString),
		publicUrl: optional(isString),
		hostname: optional(isString),
		tablePlusUrl: optional(isString),
		/** The integration stack providing it (see {@link RunEntry.stacks}); it has no container of ours. */
		stack: optional(isString),
		/** What `stop` needs to reach the container without loading the config. */
		container: optional(
			object({
				runtime: isOneOf(["docker", "apple"]),
				name: isString,
				service: optional(isString),
				binary: optional(isString),
			}),
		),
		status: isOneOf(["starting", "ready", "stopped"]),
		/**
		 * Set by the run when the container stopped, was removed or turned
		 * unhealthy under it, and cleared when it recovers. A separate field
		 * rather than a status: an older reader drops an entry whose status it
		 * does not know, and `status` stays what the run last set.
		 */
		problem: optional(isRunServiceProblem),
	}),
	endpointComplete,
);

const isRunStack = object({
	name: isString,
	/** argv, run from the checkout (or home once it is gone). Keeps data. */
	down: refine(arrayOf(isString), (argv) => argv.length > 0),
	/**
	 * The `com.docker.compose.project` label its containers carry. What stops
	 * them when `down` cannot run: a CLI that lived in a deleted checkout.
	 */
	composeProject: optional(isString),
});

const isRunTask = object({ name: isString, description: optional(isString) });

const isRunDetail = object({ label: isString, value: isString });

/**
 * Where a run is in its life, as its owner and the sweep recorded it.
 *
 * - `live`: the owner has not said it finished. It may have crashed since;
 *   only a liveness read tells, which is why readers ask {@link runPhase}.
 * - `released`: the owner exited on purpose, so its containers wait out the
 *   hold for the next run. A deliberate Ctrl-C has to be distinguishable from
 *   a crash: the crash grace is seconds, the hold minutes, and without the
 *   distinction every restart paid for a container recreate.
 * - `lost`: the sweep found the owner gone without releasing. The crash grace
 *   counts from `at`, stamped once by the sweep, so no live run pays for an
 *   accurate clock; `updatedAt` would not do, because a quiet run may not
 *   have written anything for hours before it crashed.
 */
const isRunLifecycle = oneOf(
	object({ state: isOneOf(["live"]) }),
	object({ state: isOneOf(["released", "lost"]), at: isString }),
);

/**
 * How long the containers outlive the run.
 *
 * - `checkout`: as long as the checkout exists, however the run ended
 *   (`--keep-containers`, the one-shot modes, a library `start()`).
 * - `timed`: `ms` after release; after a crash the grace applies instead.
 *   `inherited` is the hold of an earlier run whose held containers this run,
 *   which asked for none, reused: it applies from when this run ends,
 *   released or lost. Without it the newest entry said "keep forever" and a
 *   one-second script pinned a CLI run's stack for days.
 */
const isRunHold = oneOf(
	object({ kind: isOneOf(["checkout"]) }),
	object({
		kind: isOneOf(["timed"]),
		ms: refine(isFiniteNumber, (ms) => ms >= 0),
		inherited: isBoolean,
	}),
);

const isRunEntry = object({
	/**
	 * Identifies this run; every write addresses an entry by it.
	 */
	sessionId: isString,
	processIdentity: optional(isString),
	projectPrefix: isString,
	projectName: isString,
	root: isString,
	/** Worktree directory name, or `null` in the main checkout. */
	worktree: nullable(isString),
	branch: optional(isString),
	/**
	 * The process that owns this run.
	 *
	 * Its death retires the entry — unless the run owns containers, which
	 * outlive it by design: then the entry survives, invisible to every
	 * "live runs" reader, until the sweep has torn the containers down.
	 * Never zeroed on release: the menu bar asks `kill(pid, 0)`, and pid 0
	 * is that app's own process group.
	 */
	pid: isPositiveInteger,
	startedAt: isString,
	updatedAt: isString,
	lifecycle: isRunLifecycle,
	hold: isRunHold,
	primaryApp: optional(isString),
	/**
	 * Started by `dev --detach`: no terminal shows its servers, so stopping it
	 * kills nothing anyone is watching and `stop` does not ask first.
	 */
	detached: optional(isBoolean),
	/**
	 * A detached run's idle limit: the watchdog stops it after this long with
	 * no request through buncargo's proxy and no buncargo command in its
	 * checkout (`core/run-limits.ts`). Absent for a run in a terminal, and for
	 * `dev --detach --keep`.
	 */
	idleLimitMs: optional(isPositiveInteger),
	hosts: nullable(object({ active: isBoolean, tld: isString })),
	/**
	 * How to invoke this same buncargo again.
	 *
	 * A reader stopping one app must run the build that started it, not
	 * whatever `buncargo` resolves to in its own environment — in a worktree
	 * those are routinely different versions.
	 */
	cli: object({ program: isString, script: optional(isString) }),
	apps: arrayOf(isRunApp),
	services: arrayOf(isRunService),
	/**
	 * Integration stacks (the Supabase CLI) this run started, with the command
	 * that stops each. The sweep runs it when it would tear the run's
	 * containers down: it has no config to ask.
	 */
	stacks: optional(arrayOf(isRunStack)),
	/** The config's tasks, which the menu bar runs with `buncargo run <name>`. */
	tasks: optional(arrayOf(isRunTask)),
	/** Values apps printed (`captures`), by name: what `env --get captured.*` reads. */
	captures: optional(recordOf(isString)),
	/** Labelled captures and integrations' `describe` values (e.g. "Shopify preview"). */
	details: optional(arrayOf(isRunDetail)),
});

export type RunEntry = Guarded<typeof isRunEntry>;
export type RunAppEntry = Guarded<typeof isRunApp>;
export type RunAppStatus = RunAppEntry["status"];
export type RunServiceEntry = Guarded<typeof isRunService>;
export type RunServiceStatus = RunServiceEntry["status"];
export type RunServiceProblem = Guarded<typeof isRunServiceProblem>;
export type RunStackEntry = Guarded<typeof isRunStack>;
export type RunTaskEntry = Guarded<typeof isRunTask>;
export type RunDetailEntry = Guarded<typeof isRunDetail>;
export type RunLifecycle = Guarded<typeof isRunLifecycle>;
export type RunHold = Guarded<typeof isRunHold>;

/** A run nobody has said finished. */
export const LIVE: RunLifecycle = { state: "live" };

/** Containers kept for as long as the checkout exists. */
export const CHECKOUT_HOLD: RunHold = { kind: "checkout" };

/**
 * Where a run is, for every reader of the registry: `live` while its owner
 * is alive and has not released, `released` once it exited on purpose, `lost`
 * once its owner is gone without releasing, whether or not the sweep has
 * stamped that yet.
 *
 * `alive` is the reader's own reading of the owner process (an identity
 * match, `kill(pid, 0)`); a released run is never live whatever its pid says,
 * and a run the sweep stamped lost is live again once its owner reads as
 * itself. BuncargoBar's `Run.phase(alive:)` is the same rule.
 */
export type RunPhase = "live" | "released" | "lost";

export function runPhase(
	entry: Pick<RunEntry, "lifecycle">,
	alive: boolean,
): RunPhase {
	if (entry.lifecycle.state === "released") return "released";
	return alive ? "live" : "lost";
}

/** When a finished run's containers are due to come down: see {@link holdExpiry}. */
export interface HoldExpiry {
	ended: "released" | "lost";
	/** Epoch ms of the release or of the sweep first finding the owner gone. */
	endedAt: number;
	/** How long after `endedAt`. */
	holdMs: number;
	/** The hold is one this run reused from an earlier run. */
	inherited: boolean;
}

/**
 * When a finished run's containers are due to come down, or `undefined`
 * while nothing dates that: a run with no recorded end (live, or lost but not
 * yet stamped by the sweep), a hold of the checkout, or an end time that does
 * not parse.
 *
 * A crash leaves nobody to come back for the containers, so a run's own hold
 * gives way to `ownerDeadGraceMs`; a hold reused from an earlier run applies
 * however this one ended.
 */
export function holdExpiry(
	run: Pick<RunEntry, "lifecycle" | "hold">,
	ownerDeadGraceMs: number,
): HoldExpiry | undefined {
	const { lifecycle, hold } = run;
	if (lifecycle.state === "live" || hold.kind === "checkout") return undefined;
	const endedAt = Date.parse(lifecycle.at);
	if (Number.isNaN(endedAt)) return undefined;
	const crashed = lifecycle.state === "lost" && !hold.inherited;
	return {
		ended: lifecycle.state,
		endedAt,
		holdMs: crashed ? ownerDeadGraceMs : hold.ms,
		inherited: hold.inherited,
	};
}

export function getRunsPath(): string {
	return stateFilePath(RUNS_FILENAME);
}

const registry = defineListRegistry<RunEntry>({
	version: REGISTRY_VERSION,
	key: "runs",
	isEntry: isRunEntry,
	afterWrite: chownToInvokingUser,
});

/**
 * The registry's entries. A file an older buncargo wrote (`runs.json` v1)
 * reads as empty, strict or not: its entries cannot be read, and the next
 * write replaces it, keeping its bytes in a `runs.json.recovery-*` file.
 */
export async function loadRuns(
	options: ListRegistryReadOptions = {},
): Promise<RunEntry[]> {
	try {
		return await registry.read(getRunsPath(), options);
	} catch (error) {
		const older =
			error instanceof StateFileUnreadableError &&
			!(error instanceof StateFileVersionError) &&
			olderRegistryOnDisk();
		if (older) return [];
		throw error;
	}
}

function olderRegistryOnDisk(): boolean {
	return (
		readJsonDocumentSync(getRunsPath(), (value) =>
			isRecord(value) &&
			typeof value.version === "number" &&
			value.version < REGISTRY_VERSION
				? true
				: undefined,
		) ?? false
	);
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
			run.root === root && runPhase(run, isProcessAlive(run.pid)) === "live",
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
 * at a time, each answer was a fork on macOS. Live means {@link runPhase}
 * says so: a released entry never reads as live, whatever its pid.
 */
export async function runLivenessAsync(
	runs: readonly RunEntry[],
	signal?: AbortSignal,
): Promise<(run: RunEntry) => boolean> {
	const matches = await processIdentityMatcherAsync(runs, signal);
	return (run) =>
		runPhase(run, matches(run.pid, run.processIdentity)) === "live";
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
			runPhase(run, isProcessAlive(run.pid)) === "live",
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
		lifecycle: LIVE,
		hold: CHECKOUT_HOLD,
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
 * whose identity cannot be read. Only the entries `relevant` keeps are read,
 * and none forks nothing.
 */
async function livenessBeforeLock(
	path: string,
	relevant: (run: RunEntry) => boolean,
): Promise<(run: RunEntry) => boolean> {
	const checked = (await registry.read(path)).filter(relevant);
	if (checked.length === 0) return () => true;
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
 *   that the run is live again.
 * - `describe`: what the run serves (`run-publish.ts`): apps, hosts, URLs,
 *   tasks. It never touches the lifecycle, so a describe that lands after a
 *   release cannot reopen it, and it never drops what other writers recorded:
 *   app rows' processes and states, captures, a service's `problem`.
 */
export type RunPublishKind = "claim" | "describe";

/**
 * The entry a publish leaves, from the one it lands on.
 *
 * Every write of an entry is its owner's, so a publish turns `lost` back to
 * `live`: the owner is demonstrably alive.
 */
export function mergePublishedRun(
	existing: RunEntry | undefined,
	run: RunEntry,
	kind: RunPublishKind,
): RunEntry {
	if (!existing) return run;
	return typedSwitch(kind, {
		claim: (): RunEntry => {
			const { stacks: _stacks, ...kept } = existing;
			// A claim reopening a finished entry (`releaseRun()`, then `start()`
			// again) starts a new run: ranking (`newestLifecycleFirst`) and the
			// claims a teardown releases date from it.
			const reopens = existing.lifecycle.state !== "live";
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
				lifecycle: LIVE,
				hold: run.hold,
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
			startedAt: existing.startedAt,
			lifecycle:
				existing.lifecycle.state === "released" ? existing.lifecycle : LIVE,
			hold: existing.hold,
			...(existing.stacks === undefined ? {} : { stacks: existing.stacks }),
			...(existing.captures === undefined
				? {}
				: { captures: existing.captures }),
			...(run.details === undefined && existing.details !== undefined
				? { details: existing.details }
				: {}),
			apps: run.apps.map((app) => describedApp(existing.apps, app)),
			services: describedServices(existing.services, run.services),
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
		if (!current || current.lifecycle.state === "released") return undefined;
		const next = [...runs];
		const now = new Date().toISOString();
		if (current.services.length === 0) next.splice(index, 1);
		else
			next[index] = {
				...current,
				lifecycle: { state: "released", at: now },
				updatedAt: now,
			};
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
	run: Pick<RunEntry, "lifecycle" | "startedAt">,
): string {
	return run.lifecycle.state === "live" ? run.startedAt : run.lifecycle.at;
}

/** Sort order for {@link runLifecycleAt}, newest first. */
export function newestLifecycleFirst(
	a: Pick<RunEntry, "lifecycle" | "startedAt">,
	b: Pick<RunEntry, "lifecycle" | "startedAt">,
): number {
	return runLifecycleAt(b).localeCompare(runLifecycleAt(a));
}

/**
 * The hold a run that asks for none takes over, when it is about to reuse a
 * stack another run left in its hold: the newest finished entry for the same
 * project and checkout, when its hold is timed. Finished is {@link runPhase}
 * with the owner read by `kill(pid, 0)`, as a publish prunes, so the start
 * path forks no `ps` for it.
 */
export function holdToInherit(
	runs: readonly RunEntry[],
	target: { projectName: string; root: string },
): RunHold {
	// The newest decides: one that kept its containers on purpose
	// (`--keep-containers`) is not overruled by an older hold.
	const [newest] = runs
		.filter(
			(run) =>
				run.projectName === target.projectName &&
				run.root === target.root &&
				runPhase(run, isProcessAlive(run.pid)) !== "live" &&
				run.services.length > 0,
		)
		.sort(newestLifecycleFirst);
	if (newest?.hold.kind !== "timed") return CHECKOUT_HOLD;
	return { kind: "timed", ms: newest.hold.ms, inherited: true };
}

type LifecycleFields = Pick<RunEntry, "sessionId" | "startedAt" | "lifecycle">;

function sameLifecycle(a: RunLifecycle, b: RunLifecycle): boolean {
	if (a.state === "live" || b.state === "live") return a.state === b.state;
	return a.state === b.state && a.at === b.at;
}

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
		sameLifecycle(expected.lifecycle, current.lifecycle)
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
	const ofProject = (entry: RunEntry) =>
		entry.projectName === target.projectName && entry.root === target.root;
	// Only a finished entry held on the downed runtimes is retired with it:
	// liveness is read for those alone, and a teardown that downed nothing
	// forks no `ps`.
	const retirable = (entry: RunEntry) =>
		ofProject(entry) &&
		entry.sessionId !== target.sessionId &&
		heldOnlyOn(entry, target.downed);
	const alive = await livenessBeforeLock(getRunsPath(), retirable);
	await updateRuns(getRunsPath(), (runs) => {
		const retired = (entry: RunEntry) =>
			ofProject(entry) &&
			(entry.sessionId === target.sessionId ||
				(retirable(entry) && !alive(entry)));
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
 * What a sweep's reading of an owner changes: a `live` entry whose owner is
 * gone is now `lost`, a `lost` one whose owner reads as itself again is
 * `live`, and nothing else moves (a released run stays released).
 */
export function ownerChange(
	run: Pick<RunEntry, "lifecycle">,
	alive: boolean,
): "lost" | "back" | undefined {
	if (run.lifecycle.state === "live" && !alive) return "lost";
	if (run.lifecycle.state === "lost" && alive) return "back";
	return undefined;
}

/**
 * Record when the sweep first found each owner in `lost` gone, and make the
 * entries in `back`, whose owner it found running again, live. Once written,
 * the same entries in memory change too, so the pass decides from what is on
 * disk; a write that fails throws and changes nothing.
 *
 * Only ever stamps an entry that is still `live` on disk, so the grace keeps
 * counting from the first time it was noticed however many sweeps see it. A
 * stamp goes as soon as the owner reads as itself again: one wrong "gone" (a
 * `ps` that timed out) otherwise stayed for good, and `holdToInherit`
 * counted the live run as finished.
 */
export async function markOwnersLost(input: {
	lost: readonly Pick<RunEntry, "sessionId" | "lifecycle">[];
	back: readonly Pick<RunEntry, "sessionId" | "lifecycle">[];
	at: string;
}): Promise<void> {
	if (input.lost.length === 0 && input.back.length === 0) return;
	const lost = new Set(input.lost.map((run) => run.sessionId));
	const back = new Set(input.back.map((run) => run.sessionId));
	const stamped: RunLifecycle = { state: "lost", at: input.at };
	const moved = (entry: RunEntry): RunLifecycle | undefined => {
		if (lost.has(entry.sessionId) && ownerChange(entry, false) === "lost")
			return stamped;
		if (back.has(entry.sessionId) && ownerChange(entry, true) === "back")
			return LIVE;
		return undefined;
	};
	await updateRuns(getRunsPath(), (runs) => {
		let changed = false;
		const next = runs.map((entry) => {
			const lifecycle = moved(entry);
			if (lifecycle === undefined) return entry;
			changed = true;
			return { ...entry, lifecycle };
		});
		return changed ? next : undefined;
	});
	for (const run of input.lost) run.lifecycle = stamped;
	for (const run of input.back) run.lifecycle = LIVE;
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
