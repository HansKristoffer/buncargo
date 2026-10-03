import { createHash } from "node:crypto";
import { withFileLock } from "./file-lock";
import {
	processIdentityMatcherAsync,
	readCurrentProcessIdentityAsync,
} from "./process-identity";
import { defineListRegistry } from "./registry-file";
import { chownToInvokingUser, stateFilePath } from "./state-paths";

/**
 * Exclusive leases: an external resource only one run may use at a time.
 *
 * One Shopify dev app is the case that motivated them: whoever last ran
 * `shopify app dev` rewrites its app URL, so two worktrees on one app silently
 * break each other. The lease is held by the `dev` process (not the app), is
 * checked and written under one lock so two runs starting together cannot
 * both win, and needs no release to survive a crash: a holder whose process
 * is gone holds nothing.
 */

export interface LeaseEntry {
	key: string;
	sessionId: string;
	/** The `dev` process holding it. */
	pid: number;
	processIdentity?: string;
	/** The app it was taken for. */
	app: string;
	projectName: string;
	root: string;
	worktree: string | null;
	branch?: string;
	acquiredAt: string;
}

type LeaseRequest = Omit<LeaseEntry, "pid" | "processIdentity" | "acquiredAt">;

type LeaseResult = { ok: true } | { ok: false; holder: LeaseEntry };

const FILENAME = "leases.json";

function isLeaseEntry(value: unknown): value is LeaseEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.key === "string" &&
		typeof entry.sessionId === "string" &&
		typeof entry.pid === "number" &&
		typeof entry.app === "string" &&
		typeof entry.projectName === "string" &&
		typeof entry.root === "string" &&
		typeof entry.acquiredAt === "string"
	);
}

const registry = defineListRegistry<LeaseEntry>({
	version: 1,
	key: "leases",
	isEntry: isLeaseEntry,
	afterWrite: chownToInvokingUser,
});

function getLeasesPath(): string {
	return stateFilePath(FILENAME);
}

async function liveOnly(entries: LeaseEntry[]): Promise<LeaseEntry[]> {
	const alive = await processIdentityMatcherAsync(entries);
	return entries.filter((entry) => alive(entry.pid, entry.processIdentity));
}

/** Who holds what right now. */
export async function readLeases(
	path = getLeasesPath(),
): Promise<LeaseEntry[]> {
	return liveOnly(await registry.read(path));
}

function transferGate(path: string, key: string): string {
	return `${path}.transfer-${createHash("sha256").update(key).digest("hex")}`;
}

function sameHolder(left: LeaseEntry, right: LeaseEntry): boolean {
	return (
		left.key === right.key &&
		left.sessionId === right.sessionId &&
		left.pid === right.pid &&
		left.processIdentity === right.processIdentity &&
		left.acquiredAt === right.acquiredAt
	);
}

async function writeLease(
	path: string,
	live: LeaseEntry[],
	request: LeaseRequest,
): Promise<void> {
	await registry.write(path, [
		...live.filter((entry) => entry.key !== request.key),
		{
			...request,
			pid: process.pid,
			processIdentity: await readCurrentProcessIdentityAsync(),
			acquiredAt: new Date().toISOString(),
		},
	]);
}

type LeaseOptions = { path?: string; signal?: AbortSignal };

/**
 * Take a lease, or report who holds it. Re-acquiring your own is a no-op, and
 * a holder whose `dev` process is gone is dropped on the way.
 */
export async function acquireLease(
	request: LeaseRequest,
	options: LeaseOptions = {},
): Promise<LeaseResult> {
	const path = options.path ?? getLeasesPath();
	return withFileLock(
		transferGate(path, request.key),
		() =>
			withFileLock(
				path,
				async () => {
					const live = await liveOnly(await registry.read(path));
					const holder = live.find((entry) => entry.key === request.key);
					if (holder)
						return holder.sessionId === request.sessionId
							? { ok: true }
							: { ok: false, holder };
					options.signal?.throwIfAborted();
					await writeLease(path, live, request);
					return { ok: true };
				},
				options,
			),
		{ signal: options.signal, timeoutMs: 30_000 },
	);
}

type TransferResult =
	| { ok: true }
	| { ok: false; reason: "changed"; holder?: LeaseEntry }
	| { ok: false; reason: "stop-refused"; holder: LeaseEntry };

/**
 * Transfer only the ownership the caller observed, after its app has stopped.
 * The per-key gate excludes competing claims across the stop. The registry
 * lock is released while stopping so the old run can release its leases.
 */
export async function transferLease(
	request: LeaseRequest,
	expected: LeaseEntry,
	stop: (holder: LeaseEntry) => Promise<boolean>,
	options: LeaseOptions = {},
): Promise<TransferResult> {
	const path = options.path ?? getLeasesPath();
	return withFileLock(
		transferGate(path, request.key),
		async () => {
			const holder = await withFileLock(
				path,
				async () =>
					(await liveOnly(await registry.read(path))).find(
						(entry) => entry.key === request.key,
					),
				options,
			);
			if (!holder || !sameHolder(holder, expected))
				return { ok: false, reason: "changed", holder };
			options.signal?.throwIfAborted();
			if (!(await stop(holder)))
				return { ok: false, reason: "stop-refused", holder };
			return withFileLock(
				path,
				async () => {
					const live = await liveOnly(await registry.read(path));
					const current = live.find((entry) => entry.key === request.key);
					if (current && !sameHolder(current, expected))
						return { ok: false, reason: "changed", holder: current };
					options.signal?.throwIfAborted();
					await writeLease(path, live, request);
					return { ok: true };
				},
				options,
			);
		},
		{ signal: options.signal, timeoutMs: 30_000 },
	);
}

/** Give up every lease a session holds. */
export async function releaseLeases(
	sessionId: string,
	path = getLeasesPath(),
): Promise<void> {
	await withFileLock(path, async () => {
		const entries = await registry.read(path);
		const kept = (await liveOnly(entries)).filter(
			(entry) => entry.sessionId !== sessionId,
		);
		if (kept.length !== entries.length) await registry.write(path, kept);
	});
}

/** One line naming a holder, for refusals and listings. */
export function describeLeaseHolder(holder: LeaseEntry): string {
	const where = [holder.worktree ?? "main checkout", holder.branch]
		.filter(Boolean)
		.join(", ");
	return `${holder.projectName} (${where}), app "${holder.app}", pid ${holder.pid}`;
}
