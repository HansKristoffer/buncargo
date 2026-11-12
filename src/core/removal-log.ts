/**
 * The events log: every container stack and volume buncargo removed, every
 * service it stopped, and every detached run the watchdog stopped, kept so
 * the run that loses them, and `stop` and `ls` after a run is gone, can say
 * who did it and why.
 *
 * A container cannot be relabelled once it exists, and once removed there is
 * nothing left to label, so the trace has to be on our side. Without it a
 * run whose database vanished saw `ECONNREFUSED`, then "No resource found to
 * remove" from its own teardown, and the one line that explained both sat in
 * whichever watchdog's log happened to do it. A run's entry does not outlive
 * it either: without a record, "where did my detached run go?" had no answer
 * but the watchdog's log.
 *
 * Per user, like the rest of `~/.buncargo`: another user's watchdog records
 * in its own home, which is why an unexplained loss points at those logs.
 */

import { userInfo } from "node:os";
import { basename, dirname } from "node:path";
import { isOneOf, isString, truncate } from "hanzio";
import { withFileLock } from "./file-lock";
import {
	arrayOf,
	type Guarded,
	isFiniteNumber,
	nullable,
	object,
	oneOf,
	optional,
} from "./json-shape";
import { readJsonDocumentSync, writeJsonDocument } from "./registry-file";
import type { RunEntry } from "./run-registry";
import { chownToInvokingUser, stateFilePath } from "./state-paths";
import { buncargoVersion } from "./version";

/** Enough for weeks of a busy machine, small enough to rewrite whole. */
export const EVENT_LOG_LIMIT = 500;

const EVENT_LOG_VERSION = 1;

/** How far back `stop` and `ls` report a stopped run. */
const RECENT_RUN_STOP_MS = 24 * 60 * 60_000;

/** Who removed something: the process, its user and its buncargo. */
const isRemovalActor = object({
	/** As a person would type it: `buncargo watchdog`, `buncargo ls`, `seed.ts (library)`. */
	command: isString,
	pid: isFiniteNumber,
	user: isString,
	version: optional(isString),
	/**
	 * What started the command: `BuncargoBar`, `zsh`, an agent's harness.
	 * The menu bar shells out to `buncargo stop`, so only this tells its
	 * buttons from a terminal.
	 */
	parent: optional(isString),
});

/** The run a removal was decided against, as the registry recorded it. */
const isRemovalOwner = object({
	sessionId: isString,
	pid: isFiniteNumber,
	worktree: optional(nullable(isString)),
	branch: optional(isString),
});

const removalFields = {
	at: isString,
	projectName: isString,
	root: isString,
	/** The container runtime, or the integration stack's name (`supabase`). */
	runtime: isString,
	reason: isString,
	owner: optional(isRemovalOwner),
	by: isRemovalActor,
};

const isRemovalRecord = oneOf(
	object({ kind: isOneOf(["containers"]), ...removalFields }),
	object({
		kind: isOneOf(["volumes"]),
		...removalFields,
		volumes: arrayOf(isString),
	}),
	/** Only these services' containers were stopped (`buncargo stop <service>`). */
	object({
		kind: isOneOf(["services"]),
		...removalFields,
		services: arrayOf(isString),
	}),
);

/** A detached run the watchdog stopped. */
const isRunStopRecord = object({
	kind: isOneOf(["run-stopped"]),
	at: isString,
	reason: isOneOf(["idle", "checkout deleted"]),
	/** The sentence `stop` and `ls` print: "idle for 2h 0m (…)". */
	detail: isString,
	sessionId: isString,
	projectName: isString,
	root: isString,
	worktree: nullable(isString),
	pid: isFiniteNumber,
});

const isLogEvent = oneOf(isRemovalRecord, isRunStopRecord);

export type RemovalActor = Guarded<typeof isRemovalActor>;
export type RemovalOwner = Guarded<typeof isRemovalOwner>;
export type RemovalRecord = Guarded<typeof isRemovalRecord>;
export type RunStopRecord = Guarded<typeof isRunStopRecord>;
export type RunStopReason = RunStopRecord["reason"];
export type LogEvent = Guarded<typeof isLogEvent>;

/** The parts of a run entry a removal record keeps. */
export function removalOwner(
	run: RunEntry | null | undefined,
): RemovalOwner | undefined {
	if (!run) return undefined;
	return {
		sessionId: run.sessionId,
		pid: run.pid,
		worktree: run.worktree,
		...(run.branch ? { branch: run.branch } : {}),
	};
}

/** The record of one stopped run, from its entry. */
export function runStopRecord(
	run: Pick<
		RunEntry,
		"sessionId" | "projectName" | "root" | "worktree" | "pid"
	>,
	stop: { at: string; reason: RunStopReason; detail: string },
): RunStopRecord {
	return {
		kind: "run-stopped",
		...stop,
		sessionId: run.sessionId,
		projectName: run.projectName,
		root: run.root,
		worktree: run.worktree,
		pid: run.pid,
	};
}

function getEventLogFile(): string {
	return stateFilePath("events.json");
}

/**
 * The command this process runs, for a removal record.
 *
 * `process.argv[1]` is buncargo's own CLI for a command, and the user's
 * script under a library `start()`/`stop()`.
 */
export function invocationCommand(argv: readonly string[]): string {
	const script = argv[1];
	if (!script) return "buncargo";
	const name = basename(script);
	const isCli =
		name === "buncargo" ||
		((name === "bin.ts" || name === "bin.js") &&
			basename(dirname(script)) === "cli");
	if (!isCli) return `${name} (library)`;
	const command = ["buncargo", ...argv.slice(2)].join(" ");
	return truncate(command, 80);
}

function currentUser(): string {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER?.trim() || process.env.LOGNAME?.trim() || "unknown";
	}
}

/**
 * The parent process's executable name. Never throws: a removal record
 * without it is still a record, and without `ps` on `PATH` spawning it
 * throws rather than failing.
 */
function parentCommand(): string | undefined {
	try {
		const result = Bun.spawnSync(
			["ps", "-p", String(process.ppid), "-o", "comm="],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const command = result.success ? result.stdout.toString().trim() : "";
		return command ? basename(command) : undefined;
	} catch {
		return undefined;
	}
}

/** This process, as the actor of a removal. */
export function removalActor(
	command = invocationCommand(process.argv),
): RemovalActor {
	const parent = parentCommand();
	return {
		command,
		pid: process.pid,
		user: currentUser(),
		version: buncargoVersion(),
		...(parent ? { parent } : {}),
	};
}

function validateLog(value: unknown): LogEvent[] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const document = value as { version?: unknown; events?: unknown };
	if (document.version !== EVENT_LOG_VERSION) return undefined;
	return Array.isArray(document.events)
		? document.events.filter(isLogEvent)
		: undefined;
}

function readEvents(): LogEvent[] {
	return readJsonDocumentSync(getEventLogFile(), validateLog) ?? [];
}

/** What buncargo removed or stopped of containers, oldest first. */
export function readRemovals(): RemovalRecord[] {
	return readEvents().filter(
		(event): event is RemovalRecord => event.kind !== "run-stopped",
	);
}

/** The detached runs the watchdog stopped, oldest first. */
export function readRunStops(): RunStopRecord[] {
	return readEvents().filter(
		(event): event is RunStopRecord => event.kind === "run-stopped",
	);
}

/**
 * Append events, keeping the newest {@link EVENT_LOG_LIMIT}.
 *
 * Never throws: a removal or stop that happened must not read as failed
 * because its trace could not be written.
 */
export async function recordEvents(events: readonly LogEvent[]): Promise<void> {
	if (events.length === 0) return;
	const file = getEventLogFile();
	try {
		await withFileLock(file, async () => {
			const kept = [...readEvents(), ...events].slice(-EVENT_LOG_LIMIT);
			await writeJsonDocument(
				file,
				{ version: EVENT_LOG_VERSION, events: kept },
				{ afterWrite: chownToInvokingUser },
			);
		});
	} catch {
		// The removal or stop stands; only its explanation is lost.
	}
}

/** The newest removal of this checkout's project at or after `since`. */
export function findRemoval(
	records: readonly RemovalRecord[],
	target: { projectName: string; root: string; since: number },
): RemovalRecord | undefined {
	return records.findLast(
		(record) =>
			record.projectName === target.projectName &&
			record.root === target.root &&
			Date.parse(record.at) >= target.since,
	);
}

/** "buncargo's watchdog (pid 4242, user ci, buncargo 12.4.0)" */
function describeActor(actor: RemovalActor): string {
	const who =
		actor.command === "buncargo watchdog"
			? "buncargo's watchdog"
			: `\`${actor.command}\``;
	const details = [
		`pid ${actor.pid}`,
		`user ${actor.user}`,
		`buncargo ${actor.version ?? "of unknown version"}`,
		...(actor.parent ? [`run from ${actor.parent}`] : []),
	];
	return `${who} (${details.join(", ")})`;
}

export function describeRemoval(record: RemovalRecord): string {
	const { verb, what } = removalAction(record);
	return `${describeActor(record.by)} ${verb} ${record.projectName}'s ${what} at ${record.at}: ${record.reason}`;
}

function removalAction(record: RemovalRecord): { verb: string; what: string } {
	switch (record.kind) {
		case "containers":
			return { verb: "removed", what: "containers" };
		case "volumes":
			return { verb: "removed", what: `volumes ${record.volumes.join(", ")}` };
		case "services": {
			// A service stop leaves its container, stopped, for the next run.
			const noun = record.services.length === 1 ? "container" : "containers";
			return {
				verb: "stopped",
				what: `${record.services.join(", ")} ${noun}`,
			};
		}
	}
}

/**
 * Why a checkout's containers are gone, for the run that lost them: the
 * record when buncargo left one, else where to look.
 */
export function explainContainerLoss(input: {
	projectName: string;
	root: string;
	runtime: string;
	since: number;
	now: number;
	records: readonly RemovalRecord[];
}): string {
	const record = findRemoval(input.records, input);
	if (record) return describeRemoval(record);

	const since = new Date(input.since).toISOString();
	const until = new Date(input.now).toISOString();
	const events =
		input.runtime === "docker"
			? ` and \`docker events --since ${since} --until ${until} --filter label=com.docker.compose.project=${input.projectName}\``
			: "";
	return `${input.projectName}'s containers were removed outside this run between ${since} and ${until}, and this user's buncargo recorded no removal. Check other users' ~/.buncargo/watchdog.log${events}.`;
}

/**
 * Who stopped one service of a live run, for the line the run prints when
 * it notices: the newest record since `since` of that service or of the
 * whole stack, else where to look, since nothing here did it.
 */
export function explainServiceStop(input: {
	projectName: string;
	root: string;
	runtime: string;
	service: string;
	since: number;
	records: readonly RemovalRecord[];
}): string {
	const record = input.records.findLast(
		(candidate) =>
			candidate.projectName === input.projectName &&
			candidate.root === input.root &&
			Date.parse(candidate.at) >= input.since &&
			(candidate.kind !== "services" ||
				candidate.services.includes(input.service)),
	);
	if (record) return describeRemoval(record);
	const since = new Date(input.since).toISOString();
	const events =
		input.runtime === "docker"
			? `: \`docker events --since ${since} --filter label=com.docker.compose.project=${input.projectName}\``
			: "";
	return `No buncargo command of this user stopped it, so the runtime or another tool did; Docker Desktop restarting stops every container. Check other users' ~/.buncargo/watchdog.log and the runtime's events${events}.`;
}

/**
 * The stops still worth reporting: of the last day, the newest per
 * checkout, and only where no run on record has started since (that run is
 * the news now).
 */
export function recentRunStops(
	records: readonly RunStopRecord[],
	runs: readonly Pick<RunEntry, "root" | "startedAt">[],
	now: number,
): RunStopRecord[] {
	const newest = new Map<string, RunStopRecord>();
	for (const record of records) {
		const at = Date.parse(record.at);
		const recent = !Number.isNaN(at) && now - at < RECENT_RUN_STOP_MS;
		const restarted = runs.some(
			(run) => run.root === record.root && Date.parse(run.startedAt) > at,
		);
		if (recent && !restarted) newest.set(record.root, record);
		else if (restarted) newest.delete(record.root);
	}
	return [...newest.values()];
}

/** "The watchdog stopped demo's detached run at …: idle for 2h 0m (…)." */
export function describeRunStop(record: RunStopRecord): string {
	return `buncargo's watchdog stopped ${record.projectName}'s detached run (pid ${record.pid}) at ${record.at}: ${record.detail}.`;
}
