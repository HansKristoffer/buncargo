/**
 * When buncargo's proxy last served each checkout: the request half of a
 * detached run's idle limit (`core/run-limits.ts`).
 *
 * The hosts daemon is the one process that sees every request to a named
 * host, so it records them, by the route's checkout. A request costs a map
 * write; the file is written at most once per {@link PROXY_ACTIVITY_WRITE_MS}
 * when something changed, merged under its lock so a restarted daemon keeps
 * what the last one saw.
 *
 * The file is also a heartbeat: the daemon rewrites it every
 * {@link PROXY_ACTIVITY_HEARTBEAT_MS} whatever it saw, and a reader takes a
 * missing file, or one not rewritten for three beats, as "nothing counts
 * requests here". That is an older daemon (`hosts install` from a checkout on
 * an older buncargo puts one back, and its file then stops changing) or none
 * at all; reading either as "no requests" would stop a run someone is using.
 */

import { withFileLock } from "../file-lock";
import { readJsonDocumentSync, writeJsonDocument } from "../registry-file";
import { chownToInvokingUser, stateFilePath } from "../state-paths";

/** How stale a request time on disk may be; far below any idle limit. */
export const PROXY_ACTIVITY_WRITE_MS = 60_000;

/** How often the daemon rewrites the file when nothing changed. */
export const PROXY_ACTIVITY_HEARTBEAT_MS = 5 * 60_000;

/** A file not rewritten for this long is no daemon's that counts. */
const STALE_AFTER_MS = 3 * PROXY_ACTIVITY_HEARTBEAT_MS;

/** Checkouts not served for this long are dropped from the file. */
const FORGET_AFTER_MS = 7 * 24 * 60 * 60_000;

export function getProxyActivityPath(): string {
	return stateFilePath("proxy-activity.json");
}

/** Last request time (epoch ms) by checkout root. */
export type ProxyActivity = ReadonlyMap<string, number>;

interface ProxyActivityDocument {
	updatedAt: number;
	roots: Map<string, number>;
}

function validate(value: unknown): ProxyActivityDocument | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const document = value as { roots?: unknown; updatedAt?: unknown };
	const updatedAt =
		typeof document.updatedAt === "string"
			? Date.parse(document.updatedAt)
			: Number.NaN;
	if (Number.isNaN(updatedAt)) return undefined;
	if (typeof document.roots !== "object" || document.roots === null)
		return undefined;
	const roots = new Map<string, number>();
	for (const [root, at] of Object.entries(document.roots)) {
		const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
		if (!Number.isNaN(time)) roots.set(root, time);
	}
	return { updatedAt, roots };
}

function readDocument(): ProxyActivityDocument | undefined {
	return readJsonDocumentSync(getProxyActivityPath(), validate);
}

/**
 * The request times, or `undefined` when no hosts daemon that counts them is
 * running: no file, or one past its heartbeat.
 */
export function readProxyActivity(now: number): ProxyActivity | undefined {
	const document = readDocument();
	if (document === undefined) return undefined;
	const silentFor = now - document.updatedAt;
	return silentFor < STALE_AFTER_MS ? document.roots : undefined;
}

/** Merge request times into the file, newest wins, dropping long-quiet roots. */
export async function writeProxyActivity(
	seen: ProxyActivity,
	now: number,
): Promise<void> {
	const path = getProxyActivityPath();
	await withFileLock(path, async () => {
		const merged = new Map(readDocument()?.roots ?? []);
		for (const [root, at] of seen)
			merged.set(root, Math.max(at, merged.get(root) ?? 0));
		const roots: Record<string, string> = {};
		for (const [root, at] of merged)
			if (now - at < FORGET_AFTER_MS) roots[root] = new Date(at).toISOString();
		await writeJsonDocument(
			path,
			{ version: 1, updatedAt: new Date(now).toISOString(), roots },
			{ afterWrite: chownToInvokingUser },
		);
	});
}

export interface ProxyActivityRecorder {
	/** A request was proxied to a route of this checkout. */
	note: (root: string) => void;
	/**
	 * Write what changed once the last write is old enough, and the
	 * heartbeat when it is due. Never throws.
	 */
	flush: () => Promise<void>;
}

export function createProxyActivityRecorder(deps: {
	write: (seen: ProxyActivity, now: number) => Promise<void>;
	now: () => number;
}): ProxyActivityRecorder {
	const seen = new Map<string, number>();
	let dirty = false;
	// Never written: the first flush is a heartbeat, which creates the file.
	let lastWrite = Number.NEGATIVE_INFINITY;
	// Throttles the request path's attempts, which a failing write would
	// otherwise repeat on every request.
	let lastAttempt = Number.NEGATIVE_INFINITY;
	let flushing: Promise<void> | undefined;

	async function flush(): Promise<void> {
		const now = deps.now();
		const sinceWrite = now - lastWrite;
		const changed = dirty && sinceWrite >= PROXY_ACTIVITY_WRITE_MS;
		const beat = sinceWrite >= PROXY_ACTIVITY_HEARTBEAT_MS;
		if (!changed && !beat) return;
		lastAttempt = now;
		const batch = new Map(seen);
		try {
			await deps.write(batch, now);
		} catch {
			// Kept for the next flush; a request time a minute late is harmless.
			return;
		}
		lastWrite = now;
		for (const [root, at] of batch)
			if (seen.get(root) === at) seen.delete(root);
		dirty = seen.size > 0;
	}

	// The reload loop and the request path share one write at a time.
	const flushOnce = (): Promise<void> => {
		flushing ??= flush().finally(() => {
			flushing = undefined;
		});
		return flushing;
	};

	return {
		note: (root) => {
			seen.set(root, deps.now());
			dirty = true;
			// From the request path too: the reload loop is the other caller,
			// and a loop that stalls would otherwise lose every request it saw
			// and let the file go stale, which readers take as no daemon.
			const since = deps.now() - Math.max(lastWrite, lastAttempt);
			if (since >= PROXY_ACTIVITY_WRITE_MS) void flushOnce();
		},
		flush: flushOnce,
	};
}
