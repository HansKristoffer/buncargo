/** Wire contract shared by the directory, CLI, and Swift fixture tests. */
export const CONNECT_ORIGIN = "https://connect.hanskristoffer.dk";
export const LEASE_MS = 45_000;
export const HEARTBEAT_MS = 10_000;
export type TargetStatus =
	| "starting"
	| "ready"
	| "reused"
	| "stopped"
	| "failed";
export interface TargetInput {
	id: string;
	name: string;
	kind: "app" | "service";
	protocol: "http" | "tcp";
	status: TargetStatus;
	preset?: string;
	port: number;
	tablePlusUrl?: string;
}
export interface RunInput {
	sessionId: string;
	name: string;
	hostname: string;
	project: string;
	branch?: string;
	worktree: string | null;
	primaryApp?: string;
	targets: TargetInput[];
}
export interface RemoteTarget extends TargetInput {
	url: string;
}
export interface RemoteRun extends Omit<RunInput, "targets"> {
	targets: RemoteTarget[];
}
export interface Directory {
	version: 1;
	configured: boolean;
	generatedAt: number;
	origin: string;
	notice?: string;
	runs: RemoteRun[];
}
export interface Relay {
	host: string;
	port: number;
	serverName: string;
}
export interface Assignment {
	id: string;
	targetId: string;
	protocol: "http" | "tcp";
	subdomain?: string;
	secretKey?: string;
	receiverId?: string;
}
export interface PublicationLease {
	id: string;
	credential: string;
	user: string;
	relay: Relay;
	remainingMs: number;
	assignments: Assignment[];
	rejectedRecipients: number;
}
export interface VisitorLease {
	credential: string;
	user: string;
	relay: Relay;
	proxyName: string;
	secretKey: string;
	remainingMs: number;
	target: RemoteTarget;
}
export interface Receiver {
	id: string;
	owner: string;
	token: string;
	origin: string;
}
export interface TCPConnection {
	targetId: string;
	port: number;
	url: string;
	tablePlusUrl?: string;
}
export function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
export function validPort(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value > 0 &&
		value <= 65535
	);
}
export function ready(status: string) {
	return status === "ready" || status === "reused";
}
export function text(value: unknown, max = 256): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
	);
}
export function parseRun(value: unknown): RunInput {
	const r = record(value);
	if (
		!text(r.sessionId) ||
		!text(r.name, 80) ||
		!text(r.hostname) ||
		!text(r.project) ||
		(r.branch !== undefined && !text(r.branch)) ||
		(r.worktree !== null && !text(r.worktree)) ||
		!Array.isArray(r.targets) ||
		r.targets.length > 64
	)
		throw new Error("Invalid publication");
	const ids = new Set<string>();
	for (const raw of r.targets) {
		const t = record(raw);
		if (
			!text(t.id) ||
			ids.has(t.id) ||
			!text(t.name) ||
			!["app", "service"].includes(String(t.kind)) ||
			!["http", "tcp"].includes(String(t.protocol)) ||
			!["starting", "ready", "reused", "stopped", "failed"].includes(
				String(t.status),
			) ||
			!validPort(t.port) ||
			(t.preset !== undefined && !text(t.preset))
		)
			throw new Error("Invalid target");
		ids.add(t.id);
		if (t.tablePlusUrl !== undefined) {
			if (!text(t.tablePlusUrl, 2048) || t.protocol !== "tcp")
				throw new Error("Invalid database address");
			const u = new URL(t.tablePlusUrl);
			if (
				!["postgresql:", "clickhouse:", "redis:"].includes(u.protocol) ||
				!["localhost", "127.0.0.1"].includes(u.hostname) ||
				Number(u.port) !== t.port
			)
				throw new Error("Invalid database address");
		}
	}
	if (
		r.primaryApp !== undefined &&
		(!text(r.primaryApp) ||
			!r.targets.some((t) => t.name === r.primaryApp && t.kind === "app"))
	)
		throw new Error("Invalid primary app");
	// Project only contract fields; callers must never persist arbitrary request properties.
	return {
		sessionId: r.sessionId,
		name: r.name,
		hostname: r.hostname,
		project: r.project,
		branch: r.branch as string | undefined,
		worktree: r.worktree as string | null,
		primaryApp: r.primaryApp as string | undefined,
		targets: r.targets.map((t) => ({
			id: t.id,
			name: t.name,
			kind: t.kind,
			protocol: t.protocol,
			status: t.status,
			preset: t.preset,
			port: t.port,
			tablePlusUrl: t.tablePlusUrl,
		})),
	};
}
export function parseDirectory(value: unknown, origin: string): Directory {
	const d = record(value);
	if (
		d.version !== 1 ||
		typeof d.configured !== "boolean" ||
		d.origin !== origin ||
		typeof d.generatedAt !== "number" ||
		Math.abs(Date.now() - d.generatedAt) > 30_000 ||
		!Array.isArray(d.runs) ||
		d.runs.length > 100
	)
		throw new Error("Invalid connection directory");
	const ids = new Set<string>();
	for (const raw of d.runs) {
		const r = record(raw);
		parseRun(r);
		if (ids.has(String(r.sessionId)))
			throw new Error("Invalid remote identity");
		ids.add(String(r.sessionId));
		for (const t of r.targets as RemoteTarget[]) {
			if (t.protocol === "http") {
				const u = new URL(t.url),
					base = new URL(origin);
				if (
					u.protocol !== base.protocol ||
					u.port !== base.port ||
					!/^[a-f0-9]{32}$/.test(
						u.hostname.slice(0, -base.hostname.length - 1),
					) ||
					!u.hostname.endsWith(`.${base.hostname}`) ||
					u.username ||
					u.password ||
					u.search ||
					u.hash ||
					u.pathname !== "/"
				)
					throw new Error("Invalid remote URL");
			} else if (t.url !== "")
				throw new Error("TCP targets require a local visitor");
		}
	}
	return d as unknown as Directory;
}
export async function readJSON(response: Response): Promise<unknown> {
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Connection directory request failed (${response.status})`);
	}
	if (!response.body) throw new Error("Empty directory response");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > 1024 * 1024) throw new Error("Directory response too large");
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks).toString());
	} finally {
		await reader.cancel();
	}
}
