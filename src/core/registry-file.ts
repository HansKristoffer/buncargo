import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isProcessAlive } from "./process/lifecycle";

/**
 * Reading and writing buncargo's persisted state files (`routes.json`,
 * `hosts-daemon.json`, `hosts-service.json`, `ports.json`,
 * `public-tunnels.json`).
 *
 * Every read goes through a validator, so a hand-edited or half-written file
 * degrades to "no state" instead of surfacing as a nonsense value later. Every
 * write creates the parent directory, and list registries delete the file once
 * their last entry is gone rather than leaving an empty shell behind.
 *
 * Writes land through a temp file and a rename, which is atomic within a
 * directory. These files have concurrent readers — the hosts daemon re-reads
 * `routes.json` every second — and a plain `writeFile` truncates first, so a
 * reader could otherwise catch the file empty and conclude there is no state.
 * Serializing writers is a separate concern; see `withFileLock`.
 */

function tempPathFor(path: string): string {
	return `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

function serialize(document: unknown): string {
	return `${JSON.stringify(document, null, 2)}\n`;
}

/** Narrow parsed JSON to `T`, or return `undefined` to treat the file as absent. */
export type JsonValidator<T> = (value: unknown) => T | undefined;

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parse<T>(raw: string, validate: JsonValidator<T>): T | undefined {
	try {
		return validate(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

export function readJsonDocumentSync<T>(
	path: string,
	validate: JsonValidator<T>,
): T | undefined {
	try {
		return parse(readFileSync(path, "utf-8"), validate);
	} catch {
		return undefined;
	}
}

export async function readJsonDocument<T>(
	path: string,
	validate: JsonValidator<T>,
): Promise<T | undefined> {
	try {
		return parse(await readFile(path, "utf-8"), validate);
	} catch {
		return undefined;
	}
}

export function writeJsonDocumentSync(
	path: string,
	document: unknown,
	options: { afterWrite?: (path: string) => void } = {},
): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = tempPathFor(path);
	try {
		writeFileSync(temp, serialize(document), "utf-8");
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	// After the rename the file carries the temp file's ownership, so a
	// root-run daemon has to hand it back to the invoking user here.
	options.afterWrite?.(path);
}

export async function writeJsonDocument(
	path: string,
	document: unknown,
	options: { afterWrite?: (path: string) => void } = {},
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temp = tempPathFor(path);
	try {
		await writeFile(temp, serialize(document), "utf-8");
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {});
		throw error;
	}
	options.afterWrite?.(path);
}

/**
 * Is the process that registered an entry still around?
 *
 * A missing pid means the entry was registered without an owner (a static
 * route the user installed by hand), so it outlives any single dev run.
 */
export function isRouteOwnerAlive(pid: number | undefined): boolean {
	return pid === undefined || isProcessAlive(pid);
}

/**
 * A state file that exists but could not be turned into state.
 *
 * Worth its own type because the alternative — a missing file — means the
 * opposite to a reader. Collapsing the two is what let the hosts daemon serve
 * an empty world from a registry full of routes it simply could not read.
 */
export class StateFileUnreadableError extends Error {
	readonly path: string;

	constructor(path: string, reason: string) {
		super(`${path} could not be read: ${reason}`);
		this.name = "StateFileUnreadableError";
		this.path = path;
	}
}

export interface ListRegistryReadOptions {
	/**
	 * Throw {@link StateFileUnreadableError} instead of degrading an existing
	 * but unreadable file to `[]`.
	 *
	 * For consumers that only read. A writer wants the lenient behavior: it can
	 * repair the file by writing over it, while throwing would leave it stuck
	 * behind a file only a human could delete.
	 */
	strict?: boolean;
}

export interface ListRegistry<T> {
	/** Entries on disk, or `[]` when the file is missing (see `strict`). */
	read(path: string, options?: ListRegistryReadOptions): Promise<T[]>;
	/** Persist entries, removing the file when none are left. */
	write(path: string, entries: T[]): Promise<void>;
}

/**
 * A `{ version, <key>: T[] }` state file.
 *
 * A version mismatch or a non-array payload reads as empty; individual entries
 * that fail `isEntry` are dropped so one bad record cannot discard the rest.
 */
export function defineListRegistry<T>(options: {
	version: number;
	key: string;
	isEntry: (value: unknown) => value is T;
	afterWrite?: (path: string) => void;
}): ListRegistry<T> {
	const { version, key, isEntry, afterWrite } = options;

	const validate: JsonValidator<T[]> = (value) => {
		if (typeof value !== "object" || value === null) return undefined;
		const file = value as Record<string, unknown>;
		if (file.version !== version) return undefined;
		const entries = file[key];
		if (!Array.isArray(entries)) return undefined;
		return entries.filter(isEntry);
	};

	return {
		async read(path, readOptions = {}) {
			let raw: string;
			try {
				raw = await readFile(path, "utf-8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				if (!readOptions.strict) return [];
				throw new StateFileUnreadableError(path, describeError(error));
			}
			const entries = parse(raw, validate);
			if (entries) return entries;
			if (!readOptions.strict) return [];
			throw new StateFileUnreadableError(
				path,
				`not a valid version ${version} ${key} document`,
			);
		},
		async write(path, entries) {
			if (entries.length === 0) {
				await rm(path, { force: true });
				return;
			}
			await writeJsonDocument(
				path,
				{ version, [key]: entries },
				{ afterWrite },
			);
		},
	};
}
