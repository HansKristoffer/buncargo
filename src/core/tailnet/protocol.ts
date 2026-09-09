import type { Peer } from "./client";
import { record } from "./client";

export const DIRECTORY_PORT = 48443;
export const PORT_START = 20000;
export const PORT_END = 29999;
export type TargetStatus =
	| "starting"
	| "ready"
	| "reused"
	| "stopped"
	| "failed";
export interface RemoteTarget {
	id: string;
	name: string;
	kind: "app" | "service";
	protocol: "http" | "tcp";
	status: TargetStatus;
	preset?: string;
	port: number;
	url: string;
}
export interface RemoteRun {
	sessionId: string;
	machineId: string;
	hostname: string;
	project: string;
	branch?: string;
	worktree: string | null;
	primaryApp?: string;
	targets: RemoteTarget[];
}
export interface Directory {
	version: 1;
	machineId: string;
	hostname: string;
	generatedAt: number;
	runs: RemoteRun[];
}
export function validPort(port: unknown): port is number {
	return (
		typeof port === "number" &&
		Number.isInteger(port) &&
		port > 0 &&
		port <= 65535
	);
}
export function ready(status: string): boolean {
	return status === "ready" || status === "reused";
}
const text = (value: unknown, limit = 256): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= limit &&
	!/[\r\n]/.test(value) &&
	!value.includes(String.fromCharCode(0));

/** The peer list is authoritative: a remote response may never redirect us to another machine. */
export function parseDirectory(
	value: unknown,
	expected: Peer,
	now = Date.now(),
): Directory {
	const d = record(value);
	if (
		d.version !== 1 ||
		d.machineId !== expected.id ||
		d.hostname !== expected.hostname ||
		typeof d.generatedAt !== "number" ||
		!Number.isFinite(d.generatedAt) ||
		Math.abs(now - d.generatedAt) > 30000 ||
		!Array.isArray(d.runs) ||
		d.runs.length > 100
	)
		throw new Error("Invalid or stale tailnet directory");
	const ids = new Set<string>();
	for (const raw of d.runs) {
		const run = record(raw);
		if (
			!text(run.sessionId) ||
			ids.has(run.sessionId) ||
			run.machineId !== expected.id ||
			run.hostname !== expected.hostname ||
			!text(run.project) ||
			(run.branch !== undefined && !text(run.branch)) ||
			(run.worktree !== null && !text(run.worktree)) ||
			!Array.isArray(run.targets) ||
			run.targets.length > 64
		)
			throw new Error("Invalid remote environment");
		ids.add(run.sessionId);
		const targets = new Set<string>();
		for (const rawTarget of run.targets) {
			const t = record(rawTarget);
			if (
				!text(t.id) ||
				targets.has(t.id) ||
				!text(t.name) ||
				!["app", "service"].includes(String(t.kind)) ||
				!["http", "tcp"].includes(String(t.protocol)) ||
				!["starting", "ready", "reused", "stopped", "failed"].includes(
					String(t.status),
				) ||
				!validPort(t.port) ||
				t.port < PORT_START ||
				t.port > PORT_END ||
				(t.preset !== undefined && !text(t.preset)) ||
				!text(t.url, 2048)
			)
				throw new Error("Invalid remote target");
			const url = new URL(t.url);
			if (
				url.hostname !== expected.hostname ||
				url.protocol !== (t.protocol === "http" ? "https:" : "tcp:") ||
				Number(url.port) !== t.port ||
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				(url.pathname !== "/" && url.pathname !== "")
			)
				throw new Error("Invalid remote target URL");
			targets.add(t.id);
		}
		if (
			run.primaryApp !== undefined &&
			(!text(run.primaryApp) ||
				!run.targets.some((t) => t.kind === "app" && t.name === run.primaryApp))
		)
			throw new Error("Invalid primary app");
	}
	return d as unknown as Directory;
}

/** Bound responses before parsing; never follow a redirect supplied by a peer. */
export async function readDirectory(response: Response): Promise<unknown> {
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw new Error("Directory unavailable");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 1024 * 1024) throw new Error("Directory too large");
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} finally {
		await reader.cancel();
	}
}
