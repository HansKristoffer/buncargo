import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { withFileLock } from "../file-lock";
import { writeJsonDocument } from "../registry-file";
import { recordStartupMetric } from "../startup-metrics";
import { stateFilePath } from "../state-paths";
import { record } from "./client";

// ── Port constants ───────────────────────────────────────────────────────────

/** HTTPS port published on the tailnet for the machine-wide directory. */
export const DIRECTORY_PORT = 48443;

/** Loopback port the coordinator daemon binds; Serve proxies here. */
export const DIRECTORY_LOCAL_PORT = 48444;

/** Inclusive bounds of the deterministic app port pool. */
export const FIRST_APP_PORT = 20000;
export const LAST_APP_PORT = 29999;

// ── Types ────────────────────────────────────────────────────────────────────

export interface TailnetLease {
	pid: number;
	sessionId?: string;
	pendingRemoval?: boolean;
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
	version: 1 | 2;
	enabled: boolean;
	/** Persisted uninstall intent; the coordinator finishes cleanup on reconnect. */
	removing?: boolean;
	allocations: TailnetAllocation[];
	directory?: { hostname: string; target: string; port?: number };
}

// ── Identity ─────────────────────────────────────────────────────────────────

/** Stable 16-hex id for a checkout root, used in allocation keys. */
export function workspaceId(root: string): string {
	let canonical = root;

	try {
		canonical = realpathSync(root);
	} catch {
		/* Missing checkout retains its recorded identity. */
	}

	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// ── Persistence ──────────────────────────────────────────────────────────────

export function tailnetStatePath(): string {
	return stateFilePath("tailnet.json");
}

const TAILNET_HOSTNAME = /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/;

function parseLease(value: unknown): TailnetLease {
	const l = record(value);

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
		!TAILNET_HOSTNAME.test(l.hostname) ||
		typeof l.createdAt !== "number" ||
		(l.sessionId !== undefined && typeof l.sessionId !== "string") ||
		(l.pendingRemoval !== undefined && typeof l.pendingRemoval !== "boolean")
	) {
		throw new Error("Invalid tailnet lease");
	}

	return {
		pid: l.pid,
		sessionId: l.sessionId as string | undefined,
		pendingRemoval: l.pendingRemoval as boolean | undefined,
		identity: l.identity,
		root: l.root,
		app: l.app,
		upstream: l.upstream,
		hostname: l.hostname,
		createdAt: l.createdAt,
	};
}

function parseAllocation(value: unknown): TailnetAllocation {
	const a = record(value);

	if (
		typeof a.key !== "string" ||
		typeof a.port !== "number" ||
		!Number.isInteger(a.port) ||
		a.port < FIRST_APP_PORT ||
		a.port > LAST_APP_PORT
	) {
		throw new Error("Invalid tailnet allocation");
	}

	const lease = a.lease !== undefined ? parseLease(a.lease) : undefined;

	return { key: a.key, port: a.port, ...(lease ? { lease } : {}) };
}

function parseDirectory(value: unknown): TailnetState["directory"] | undefined {
	if (value === undefined) return undefined;

	const d = record(value);

	if (
		typeof d.hostname !== "string" ||
		!TAILNET_HOSTNAME.test(d.hostname) ||
		d.target !== `http://127.0.0.1:${DIRECTORY_LOCAL_PORT}` ||
		(d.port !== undefined &&
			(typeof d.port !== "number" ||
				!Number.isInteger(d.port) ||
				d.port < 40000 ||
				d.port > 49999 ||
				d.port === DIRECTORY_LOCAL_PORT))
	) {
		throw new Error("Invalid tailnet directory ownership");
	}

	return {
		hostname: d.hostname,
		target: d.target,
		port: typeof d.port === "number" ? d.port : DIRECTORY_PORT,
	};
}

export function readTailnetState(): TailnetState {
	const path = tailnetStatePath();

	if (!existsSync(path)) {
		return { version: 2, enabled: false, allocations: [] };
	}

	const v = record(JSON.parse(readFileSync(path, "utf8")));

	if (
		(v.version !== 1 && v.version !== 2) ||
		typeof v.enabled !== "boolean" ||
		(v.removing !== undefined && typeof v.removing !== "boolean") ||
		!Array.isArray(v.allocations)
	) {
		throw new Error(
			`Invalid or newer tailnet state in ${path}; refusing to overwrite it`,
		);
	}

	const allocations = v.allocations.map(parseAllocation);

	if (
		new Set(allocations.map((a) => a.key)).size !== allocations.length ||
		new Set(allocations.map((a) => a.port)).size !== allocations.length
	) {
		throw new Error("Duplicate tailnet allocation");
	}

	const directory = parseDirectory(v.directory);

	return {
		version: 2,
		enabled: v.enabled,
		removing: v.removing as boolean | undefined,
		allocations,
		...(directory ? { directory } : {}),
	};
}

/** Locked read-modify-write over `~/.buncargo/tailnet.json`. */
export async function mutateTailnet<T>(
	fn: (state: TailnetState, save: () => Promise<void>) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const started = performance.now();
	return withFileLock(
		tailnetStatePath(),
		async () => {
			recordStartupMetric("tailnetLockWaitMs", performance.now() - started);
			const state = readTailnetState();
			const save = () => {
				// v1 writers discard cleanup intent; prevent an older coordinator from rewriting it.
				state.version = 2;
				return writeJsonDocument(tailnetStatePath(), state);
			};

			return fn(state, save);
		},
		{ timeoutMs: 120000, signal },
	);
}

// ── Port allocation ──────────────────────────────────────────────────────────

/**
 * Pick the first free port in the app pool for `key`, probing from a
 * deterministic hash offset when the preferred slot is taken.
 */
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
