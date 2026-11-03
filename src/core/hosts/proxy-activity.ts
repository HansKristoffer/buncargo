/**
 * When buncargo's proxy last served each checkout: the request half of a
 * detached run's idle limit (`core/run-limits.ts`).
 *
 * The hosts daemon is the one process that sees every request to a named
 * host, so it records them, by the route's checkout. A request costs a map
 * write; the file is written at most once per {@link PROXY_ACTIVITY_WRITE_MS}
 * and only when something changed, merged under its lock so a restarted
 * daemon keeps what the last one saw.
 *
 * The daemon writes the file on its first reload, requests or not. So a file
 * that exists says "a daemon here counts requests", and a missing one means
 * an older daemon that does not: a reader must not take that for "no
 * requests" and stop a run someone is using.
 */

import { withFileLock } from "../file-lock";
import { readJsonDocumentSync, writeJsonDocument } from "../registry-file";
import { chownToInvokingUser, stateFilePath } from "../state-paths";

/** How stale a request time on disk may be; far below any idle limit. */
export const PROXY_ACTIVITY_WRITE_MS = 60_000;

/** Checkouts not served for this long are dropped from the file. */
const FORGET_AFTER_MS = 7 * 24 * 60 * 60_000;

export function getProxyActivityPath(): string {
	return stateFilePath("proxy-activity.json");
}

/** Last request time (epoch ms) by checkout root. */
export type ProxyActivity = ReadonlyMap<string, number>;

function validate(value: unknown): Map<string, number> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const roots = (value as { roots?: unknown }).roots;
	if (typeof roots !== "object" || roots === null) return undefined;
	const activity = new Map<string, number>();
	for (const [root, at] of Object.entries(roots)) {
		const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
		if (!Number.isNaN(time)) activity.set(root, time);
	}
	return activity;
}

/** `undefined` when no daemon that records requests has run on this machine. */
export function readProxyActivity(
	path = getProxyActivityPath(),
): ProxyActivity | undefined {
	return readJsonDocumentSync(path, validate);
}

/** Merge request times into the file, newest wins, dropping long-quiet roots. */
export async function writeProxyActivity(
	seen: ProxyActivity,
	now: number,
	path = getProxyActivityPath(),
): Promise<void> {
	await withFileLock(path, async () => {
		const merged = new Map(readProxyActivity(path) ?? []);
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
	/** Write what changed, if the last write is old enough. Never throws. */
	flush: () => Promise<void>;
}

export function createProxyActivityRecorder(deps: {
	write: (seen: ProxyActivity, now: number) => Promise<void>;
	now: () => number;
}): ProxyActivityRecorder {
	const seen = new Map<string, number>();
	// Dirty from the start, so the first flush creates the file.
	let dirty = true;
	let lastWrite = Number.NEGATIVE_INFINITY;
	return {
		note: (root) => {
			seen.set(root, deps.now());
			dirty = true;
		},
		flush: async () => {
			const now = deps.now();
			if (!dirty || now - lastWrite < PROXY_ACTIVITY_WRITE_MS) return;
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
		},
	};
}
