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
	const run = record(value);
	if (
		!text(run.sessionId) ||
		!text(run.name, 80) ||
		!text(run.hostname) ||
		!text(run.project) ||
		(run.branch !== undefined && !text(run.branch)) ||
		(run.worktree !== null && !text(run.worktree)) ||
		!Array.isArray(run.targets) ||
		run.targets.length > 64
	) {
		throw new Error("Invalid publication");
	}
	const ids = new Set<string>();
	for (const raw of run.targets) {
		const target = record(raw);
		if (
			!text(target.id) ||
			ids.has(target.id) ||
			!text(target.name) ||
			!["app", "service"].includes(String(target.kind)) ||
			!["http", "tcp"].includes(String(target.protocol)) ||
			!["starting", "ready", "reused", "stopped", "failed"].includes(
				String(target.status),
			) ||
			!validPort(target.port) ||
			(target.preset !== undefined && !text(target.preset))
		) {
			throw new Error("Invalid target");
		}
		ids.add(target.id);
		if (target.tablePlusUrl !== undefined) {
			if (!text(target.tablePlusUrl, 2048) || target.protocol !== "tcp") {
				throw new Error("Invalid database address");
			}
			const url = new URL(target.tablePlusUrl);
			if (
				!["postgresql:", "clickhouse:", "redis:"].includes(url.protocol) ||
				!["localhost", "127.0.0.1"].includes(url.hostname) ||
				Number(url.port) !== target.port
			) {
				throw new Error("Invalid database address");
			}
		}
	}
	if (
		run.primaryApp !== undefined &&
		(!text(run.primaryApp) ||
			!run.targets.some(
				(target) => target.name === run.primaryApp && target.kind === "app",
			))
	) {
		throw new Error("Invalid primary app");
	}
	// Project only contract fields; callers must never persist arbitrary request properties.
	return {
		sessionId: run.sessionId,
		name: run.name,
		hostname: run.hostname,
		project: run.project,
		branch: run.branch as string | undefined,
		worktree: run.worktree as string | null,
		primaryApp: run.primaryApp as string | undefined,
		targets: run.targets.map((target) => ({
			id: target.id,
			name: target.name,
			kind: target.kind,
			protocol: target.protocol,
			status: target.status,
			preset: target.preset,
			port: target.port,
			tablePlusUrl: target.tablePlusUrl,
		})),
	};
}

export function parseDirectory(value: unknown, origin: string): Directory {
	const directory = record(value);
	if (
		directory.version !== 1 ||
		typeof directory.configured !== "boolean" ||
		directory.origin !== origin ||
		typeof directory.generatedAt !== "number" ||
		Math.abs(Date.now() - directory.generatedAt) > 30_000 ||
		!Array.isArray(directory.runs) ||
		directory.runs.length > 100
	) {
		throw new Error("Invalid connection directory");
	}
	const ids = new Set<string>();
	for (const raw of directory.runs) {
		const run = record(raw);
		parseRun(run);
		if (ids.has(String(run.sessionId))) {
			throw new Error("Invalid remote identity");
		}
		ids.add(String(run.sessionId));
		for (const target of run.targets as RemoteTarget[]) {
			if (target.protocol === "http") {
				const url = new URL(target.url);
				const base = new URL(origin);
				if (
					url.protocol !== base.protocol ||
					url.port !== base.port ||
					!/^[a-f0-9]{32}$/.test(
						url.hostname.slice(0, -base.hostname.length - 1),
					) ||
					!url.hostname.endsWith(`.${base.hostname}`) ||
					url.username ||
					url.password ||
					url.search ||
					url.hash ||
					url.pathname !== "/"
				) {
					throw new Error("Invalid remote URL");
				}
			} else if (target.url !== "") {
				throw new Error("TCP targets require a local visitor");
			}
		}
	}
	return directory as unknown as Directory;
}
