import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { promiseTimeout, typedSwitch } from "hanzio";
import { isProcessAlive } from "../process/lifecycle";
import { getStateDir } from "../state-paths";
import { checkoutPathError } from "./spec";

/**
 * The file store: this machine's copy of a repository's checkout files, at
 * `~/.buncargo/files/<repo key>/`. Its layout, write protocol and lock are a
 * contract with agentgate, which syncs stores between machines without
 * buncargo's code (docs/internals/checkout-files.md).
 */

const STORE_VERSION = 1;
export const MAX_FILE_BYTES = 1024 * 1024;
export const LOCK_STALE_MS = 30_000;

interface ManifestEntry {
	sha256: string;
	updatedAt: string;
	machine: boolean;
}

export interface Manifest {
	version: typeof STORE_VERSION;
	files: Record<string, ManifestEntry>;
}

type StoreRead =
	| { kind: "absent" }
	/** Another program's format, or a manifest that does not parse: left alone. */
	| { kind: "unusable"; reason: string }
	| { kind: "ok"; manifest: Manifest };

export function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export function storeDir(repoKey: string, home?: string): string {
	return join(getStateDir(home), "files", ...repoKey.split("/"));
}

function dataPath(dir: string, path: string): string {
	return join(dir, "data", ...path.split("/"));
}

export function readManifest(dir: string): StoreRead {
	let text: string;
	try {
		text = readFileSync(join(dir, "manifest.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { kind: "absent" };
		throw error;
	}
	let value: { version?: unknown; files?: unknown };
	try {
		value = JSON.parse(text);
	} catch {
		return { kind: "unusable", reason: "manifest.json does not parse" };
	}
	if (value?.version !== STORE_VERSION)
		return {
			kind: "unusable",
			reason: `manifest.json has version ${JSON.stringify(value?.version)}, this buncargo reads ${STORE_VERSION}`,
		};
	// Entries this version cannot read are skipped, not fatal: they may belong
	// to a newer checkout's config.
	const files: Record<string, ManifestEntry> = {};
	if (typeof value.files === "object" && value.files !== null)
		for (const [path, entry] of Object.entries(value.files)) {
			const {
				sha256: hash,
				updatedAt,
				machine,
			} = (entry ?? {}) as Record<string, unknown>;
			if (
				checkoutPathError(path) ||
				typeof hash !== "string" ||
				!/^[0-9a-f]{64}$/.test(hash) ||
				typeof updatedAt !== "string"
			)
				continue;
			files[path] = { sha256: hash, updatedAt, machine: machine === true };
		}
	return { kind: "ok", manifest: { version: STORE_VERSION, files } };
}

/**
 * The manifest to read and write through, undefined while the store does not
 * exist. A store another program owns is left alone: this throws naming the fix.
 */
export function readStoreManifest(dir: string): Manifest | undefined {
	return typedSwitch(readManifest(dir), "kind", {
		absent: () => undefined,
		unusable: ({ reason }) => {
			throw new Error(
				`Left the file store ${dir} alone: ${reason}. Update buncargo, or move the directory aside.`,
			);
		},
		ok: ({ manifest }) => manifest,
	});
}

/**
 * An entry's bytes, or undefined when they are not there yet.
 *
 * A data file whose hash differs from its entry is mid-write (data is written
 * before the manifest) and reads as absent until a later read.
 */
export function readStoreData(
	dir: string,
	path: string,
	entry: ManifestEntry,
): Buffer | undefined {
	try {
		const data = readFileSync(dataPath(dir, path));
		return sha256(data) === entry.sha256 ? data : undefined;
	} catch {
		return undefined;
	}
}

/** Write through a temp file in the same directory and rename. */
export function writeFileAtomic(
	path: string,
	data: string | Uint8Array,
	{ mode = 0o600, dirMode = 0o700 } = {},
): void {
	mkdirSync(dirname(path), { recursive: true, mode: dirMode });
	const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
	try {
		writeFileSync(temp, data, { mode });
		chmodSync(temp, mode);
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

export interface StoreWrite {
	path: string;
	data: Uint8Array;
	machine: boolean;
	/** Kept from an imported bundle; defaults to now. */
	updatedAt?: string;
}

/**
 * Write entries: every data file first, then the manifest. The caller holds
 * the lock and passes the manifest it read under it (undefined for a new store).
 */
export function writeStoreEntries(
	dir: string,
	manifest: Manifest | undefined,
	writes: readonly StoreWrite[],
	now = new Date(),
): Manifest {
	const files = { ...manifest?.files };
	for (const write of writes) {
		// Always rewritten: an entry whose data file was lost or torn would
		// otherwise stay unreadable forever.
		writeFileAtomic(dataPath(dir, write.path), write.data);
		const hash = sha256(write.data);
		const previous = files[write.path];
		files[write.path] = {
			sha256: hash,
			updatedAt:
				write.updatedAt ??
				(previous?.sha256 === hash ? previous.updatedAt : now.toISOString()),
			machine: write.machine,
		};
	}
	const next: Manifest = { version: STORE_VERSION, files };
	writeFileAtomic(
		join(dir, "manifest.json"),
		`${JSON.stringify(next, null, 2)}\n`,
	);
	return next;
}

interface LockOwner {
	pid: number;
	host: string;
	createdAt: string;
}

/**
 * Whether a lock someone else holds can be broken: its owner is dead on this
 * host, or it is older than {@link LOCK_STALE_MS}. A lock without a readable
 * owner is being created, unless its directory is that old.
 */
export function isLockStale(
	owner: unknown,
	lockMtimeMs: number,
	now: number,
	host: string,
	isAlive: (pid: number) => boolean,
): boolean {
	const {
		pid,
		host: ownerHost,
		createdAt,
	} = (owner ?? {}) as Partial<Record<keyof LockOwner, unknown>>;
	if (
		typeof pid !== "number" ||
		typeof ownerHost !== "string" ||
		typeof createdAt !== "string" ||
		Number.isNaN(Date.parse(createdAt))
	)
		return now - lockMtimeMs > LOCK_STALE_MS;
	if (now - Date.parse(createdAt) > LOCK_STALE_MS) return true;
	return ownerHost === host && !isAlive(pid);
}

function readOwner(lockDir: string): unknown {
	try {
		return JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Run `body` holding the store's lock: `mkdir <store>/.lock`, which is atomic
 * and works across programs (buncargo's flock helper does not).
 */
export async function withStoreLock<T>(
	dir: string,
	body: () => T | Promise<T>,
	timeoutMs = 10_000,
): Promise<T> {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lockDir = join(dir, ".lock");
	const deadline = Date.now() + timeoutMs;
	const host = hostname();
	for (;;) {
		try {
			mkdirSync(lockDir, { mode: 0o700 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const holder = readOwner(lockDir);
		let mtime: number;
		try {
			mtime = statSync(lockDir).mtimeMs;
		} catch {
			continue; // released between the mkdir and the stat
		}
		if (isLockStale(holder, mtime, Date.now(), host, isProcessAlive)) {
			// ponytail: two processes breaking the same stale lock can race, one
			// removing the lock the other just took. Both hold it for milliseconds
			// and every write is a rename, so the cost is a lost update, not a
			// torn file.
			rmSync(lockDir, { recursive: true, force: true });
			continue;
		}
		if (Date.now() > deadline) {
			const who = holder as Partial<LockOwner> | undefined;
			throw new Error(
				`The file store ${dir} is locked by pid ${who?.pid ?? "?"} on ${who?.host ?? "?"} since ${who?.createdAt ?? "?"}. If that process is gone, remove ${lockDir}.`,
			);
		}
		await promiseTimeout(20);
	}
	const owner: LockOwner = {
		pid: process.pid,
		host,
		createdAt: new Date().toISOString(),
	};
	writeFileSync(join(lockDir, "owner.json"), JSON.stringify(owner), {
		mode: 0o600,
	});

	try {
		return await body();
	} finally {
		const current = readOwner(lockDir) as Partial<LockOwner> | undefined;
		// Only our own lock: a slow body's lock may have been broken as stale.
		if (current?.pid === owner.pid && current.createdAt === owner.createdAt)
			rmSync(lockDir, { recursive: true, force: true });
	}
}
