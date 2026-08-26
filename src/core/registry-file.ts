import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isProcessAlive } from "./process";

/**
 * Reading and writing buncargo's persisted state files (`routes.json`,
 * `hosts-daemon.json`, `ports.json`, `public-tunnels.json`).
 *
 * Every read goes through a validator, so a hand-edited or half-written file
 * degrades to "no state" instead of surfacing as a nonsense value later. Every
 * write creates the parent directory, and list registries delete the file once
 * their last entry is gone rather than leaving an empty shell behind.
 */

/** Narrow parsed JSON to `T`, or return `undefined` to treat the file as absent. */
export type JsonValidator<T> = (value: unknown) => T | undefined;

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
	writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
	options.afterWrite?.(path);
}

export async function writeJsonDocument(
	path: string,
	document: unknown,
	options: { afterWrite?: (path: string) => void } = {},
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
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

export interface ListRegistry<T> {
	/** Entries on disk, or `[]` when the file is missing, stale, or invalid. */
	read(path: string): Promise<T[]>;
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
		async read(path) {
			return (await readJsonDocument(path, validate)) ?? [];
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
