import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { withFileLock } from "../file-lock";
import { writeJsonDocument } from "../registry-file";
import { stateFilePath } from "../state-paths";
import { record } from "./client";

export const DIRECTORY_PORT = 48443;

export const DIRECTORY_LOCAL_PORT = 48444;

export const FIRST_APP_PORT = 20000;

export const LAST_APP_PORT = 29999;

export interface TailnetLease {
	pid: number;
	identity: string;
	root: string;
	app: string;
	upstream: number;
	hostname: string;
	createdAt: number;
}

export interface TailnetAllocation {
	key: string;
	port: number;
	lease?: TailnetLease;
}

export interface TailnetState {
	version: 1;
	enabled: boolean;
	allocations: TailnetAllocation[];
	directory?: { hostname: string; target: string; port?: number };
}

export function workspaceId(root: string): string {
	let canonical = root;
	try {
		canonical = realpathSync(root);
	} catch {
		/* Missing checkout retains its recorded identity. */
	}

	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function tailnetStatePath(): string {
	return stateFilePath("tailnet.json");
}

export function readTailnetState(): TailnetState {
	const path = tailnetStatePath();
	if (!existsSync(path)) return { version: 1, enabled: false, allocations: [] };
	const v = record(JSON.parse(readFileSync(path, "utf8")));
	if (
		v.version !== 1 ||
		typeof v.enabled !== "boolean" ||
		!Array.isArray(v.allocations)
	)
		throw new Error(
			`Invalid or newer tailnet state in ${path}; refusing to overwrite it`,
		);
	const allocations = v.allocations.map((value) => {
		const a = record(value);
		if (
			typeof a.key !== "string" ||
			typeof a.port !== "number" ||
			!Number.isInteger(a.port) ||
			a.port < FIRST_APP_PORT ||
			a.port > LAST_APP_PORT
		)
			throw new Error("Invalid tailnet allocation");
		let lease: TailnetLease | undefined;
		if (a.lease !== undefined) {
			const l = record(a.lease);
			if (
				typeof l.pid !== "number" ||
				!Number.isInteger(l.pid) ||
				l.pid <= 1 ||
				typeof l.identity !== "string" ||
				typeof l.root !== "string" ||
				typeof l.app !== "string" ||
				typeof l.upstream !== "number" ||
				!Number.isInteger(l.upstream) ||
				l.upstream < 1 ||
				l.upstream > 65535 ||
				typeof l.hostname !== "string" ||
				!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(l.hostname) ||
				typeof l.createdAt !== "number"
			)
				throw new Error("Invalid tailnet lease");
			lease = {
				pid: l.pid,
				identity: l.identity,
				root: l.root,
				app: l.app,
				upstream: l.upstream,
				hostname: l.hostname,
				createdAt: l.createdAt,
			};
		}

		return { key: a.key, port: a.port, ...(lease ? { lease } : {}) };
	});
	if (
		new Set(allocations.map((a) => a.key)).size !== allocations.length ||
		new Set(allocations.map((a) => a.port)).size !== allocations.length
	)
		throw new Error("Duplicate tailnet allocation");
	let directory: TailnetState["directory"];
	if (v.directory !== undefined) {
		const d = record(v.directory);
		if (
			typeof d.hostname !== "string" ||
			!/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(d.hostname) ||
			d.target !== `http://127.0.0.1:${DIRECTORY_LOCAL_PORT}` ||
			(d.port !== undefined &&
				(typeof d.port !== "number" ||
					!Number.isInteger(d.port) ||
					d.port < 40000 ||
					d.port > 49999 ||
					d.port === DIRECTORY_LOCAL_PORT))
		)
			throw new Error("Invalid tailnet directory ownership");
		directory = {
			hostname: d.hostname,
			target: d.target,
			port: typeof d.port === "number" ? d.port : DIRECTORY_PORT,
		};
	}

	return {
		version: 1,
		enabled: v.enabled,
		allocations,
		...(directory ? { directory } : {}),
	};
}

export async function mutateTailnet<T>(
	fn: (state: TailnetState, save: () => Promise<void>) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	return withFileLock(
		tailnetStatePath(),
		async () => {
			const state = readTailnetState();
			const save = () => writeJsonDocument(tailnetStatePath(), state);
			return fn(state, save);
		},
		{ timeoutMs: 120000, signal },
	);
}

export function allocationPort(
	key: string,
	occupied: ReadonlySet<number>,
): number {
	const offset = Number.parseInt(
		createHash("sha256").update(key).digest("hex").slice(0, 8),
		16,
	);
	const count = LAST_APP_PORT - FIRST_APP_PORT + 1;
	for (let n = 0; n < count; n++) {
		const port = FIRST_APP_PORT + ((offset + n) % count);
		if (!occupied.has(port)) return port;
	}
	throw new Error("Buncargo tailnet port pool is full");
}
