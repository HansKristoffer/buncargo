import { withFileLock } from "./file-lock";
import {
	processIdentityMatcher,
	readProcessIdentity,
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

function liveOnly(entries: LeaseEntry[]): LeaseEntry[] {
	const alive = processIdentityMatcher(entries);
	return entries.filter((entry) => alive(entry.pid, entry.processIdentity));
}

/** Who holds what right now. */
export async function readLeases(
	path = getLeasesPath(),
): Promise<LeaseEntry[]> {
	return liveOnly(await registry.read(path));
}

/**
 * Take a lease, or report who holds it. Re-acquiring your own is a no-op, and
 * a holder whose `dev` process is gone is dropped on the way.
 */
export async function acquireLease(
	request: LeaseRequest,
	options: { path?: string; force?: boolean } = {},
): Promise<LeaseResult> {
	const path = options.path ?? getLeasesPath();
	return withFileLock(path, async () => {
		const live = liveOnly(await registry.read(path));
		const holder = live.find(
			(entry) =>
				entry.key === request.key && entry.sessionId !== request.sessionId,
		);
		// `force` is the takeover: the holder's app has been stopped, but its
		// `dev` process may live on, so its entry would otherwise still count.
		if (holder && !options.force) return { ok: false, holder };

		await registry.write(path, [
			...live.filter((entry) => entry.key !== request.key),
			{
				...request,
				pid: process.pid,
				processIdentity: readProcessIdentity(process.pid),
				acquiredAt: new Date().toISOString(),
			},
		]);
		return { ok: true };
	});
}

/** Give up every lease a session holds. */
export async function releaseLeases(
	sessionId: string,
	path = getLeasesPath(),
): Promise<void> {
	await withFileLock(path, async () => {
		const entries = await registry.read(path);
		const kept = liveOnly(entries).filter(
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
