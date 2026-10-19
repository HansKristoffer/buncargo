/**
 * A record of every container stack and volume buncargo removed, kept so the
 * run that loses them can say who did it.
 *
 * A container cannot be relabelled once it exists, and once removed there is
 * nothing left to label, so the trace has to be on our side. Without it a
 * run whose database vanished saw `ECONNREFUSED`, then "No resource found to
 * remove" from its own teardown, and the one line that explained both sat in
 * whichever watchdog's log happened to do it.
 *
 * Per user, like the rest of `~/.buncargo`: another user's watchdog records
 * in its own home, which is why an unexplained loss points at those logs.
 */

import { userInfo } from "node:os";
import { basename, dirname } from "node:path";
import { withFileLock } from "./file-lock";
import { readJsonDocumentSync, writeJsonDocument } from "./registry-file";
import type { RunEntry } from "./run-registry";
import { chownToInvokingUser, stateFilePath } from "./state-paths";
import { buncargoVersion } from "./version";

/** Enough for weeks of a busy machine, small enough to rewrite whole. */
export const REMOVAL_LOG_LIMIT = 500;

/** Who removed something: the process, its user and its buncargo. */
export interface RemovalActor {
	/** As a person would type it: `buncargo watchdog`, `buncargo ls`, `seed.ts (library)`. */
	command: string;
	pid: number;
	user: string;
	version?: string;
	/**
	 * What started the command: `BuncargoBar`, `zsh`, an agent's harness.
	 * The menu bar shells out to `buncargo stop`, so only this tells its
	 * buttons from a terminal.
	 */
	parent?: string;
}

/** The run a removal was decided against, as the registry recorded it. */
export interface RemovalOwner {
	sessionId: string;
	pid: number;
	worktree?: string | null;
	branch?: string;
}

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

export interface RemovalRecord {
	at: string;
	projectName: string;
	root: string;
	/** The container runtime, or the integration stack's name (`supabase`). */
	runtime: string;
	reason: string;
	owner?: RemovalOwner;
	/** Set when volumes were removed; absent for containers. */
	volumes?: string[];
	/** Set when only these services' containers were stopped (`buncargo stop <service>`). */
	services?: string[];
	by: RemovalActor;
}

export function getRemovalLogFile(): string {
	return stateFilePath("removals.json");
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
	return command.length > 80 ? `${command.slice(0, 79)}…` : command;
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

function isRemovalRecord(value: unknown): value is RemovalRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<RemovalRecord>;
	return (
		typeof record.at === "string" &&
		typeof record.projectName === "string" &&
		typeof record.root === "string" &&
		typeof record.reason === "string" &&
		typeof record.by === "object" &&
		record.by !== null &&
		typeof record.by.command === "string"
	);
}

function validateLog(value: unknown): RemovalRecord[] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const removals = (value as { removals?: unknown }).removals;
	return Array.isArray(removals) ? removals.filter(isRemovalRecord) : undefined;
}

export function readRemovals(file = getRemovalLogFile()): RemovalRecord[] {
	return readJsonDocumentSync(file, validateLog) ?? [];
}

/**
 * Append records, keeping the newest {@link REMOVAL_LOG_LIMIT}.
 *
 * Never throws: a removal that happened must not read as failed because its
 * trace could not be written.
 */
export async function recordRemovals(
	records: readonly RemovalRecord[],
	file = getRemovalLogFile(),
): Promise<void> {
	if (records.length === 0) return;
	try {
		await withFileLock(file, async () => {
			const removals = [...readRemovals(file), ...records].slice(
				-REMOVAL_LOG_LIMIT,
			);
			await writeJsonDocument(
				file,
				{ version: 1, removals },
				{ afterWrite: chownToInvokingUser },
			);
		});
	} catch {
		// The removal stands; only its explanation is lost.
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
export function describeActor(actor: RemovalActor): string {
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
	const serviceNoun =
		record.services?.length === 1 ? "container" : "containers";
	const what = record.volumes
		? `volumes ${record.volumes.join(", ")}`
		: record.services
			? `${record.services.join(", ")} ${serviceNoun}`
			: "containers";
	// A service stop leaves its container, stopped, for the next run.
	const verb = record.services ? "stopped" : "removed";
	return `${describeActor(record.by)} ${verb} ${record.projectName}'s ${what} at ${record.at}: ${record.reason}`;
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
			(!candidate.services || candidate.services.includes(input.service)),
	);
	if (record) return describeRemoval(record);
	const since = new Date(input.since).toISOString();
	const events =
		input.runtime === "docker"
			? `: \`docker events --since ${since} --filter label=com.docker.compose.project=${input.projectName}\``
			: "";
	return `No buncargo command of this user stopped it, so the runtime or another tool did; Docker Desktop restarting stops every container. Check other users' ~/.buncargo/watchdog.log and the runtime's events${events}.`;
}
