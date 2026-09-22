/** Wire contract shared by the publisher, the receiver, the CLI and the Swift fixture tests. */

/** One ALPN for the whole protocol; a version bump is a new string, never a field. */
export const CONNECT_ALPN = "buncargo/connect/1";

/** How often a publisher resends its runs. */
export const HEARTBEAT_MS = 10_000;

/** A publisher that has been silent for longer than this is hidden even if its connection lingers. */
export const STALE_MS = 45_000;

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

/** What a receiver publishes: the same target, addressed by the loopback port it bound for it. */
export interface RemoteTarget extends TargetInput {
	url: string;
}

export interface RemoteRun extends Omit<RunInput, "targets"> {
	publisherId: string;
	targets: RemoteTarget[];
}

export interface Directory {
	version: 1;
	configured: boolean;
	generatedAt: number;
	notice?: string;
	runs: RemoteRun[];
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

const HEX32 = /^[a-f0-9]{64}$/;

/** An endpoint ID is an ed25519 public key, so the CLI can mint one without loading iroh. */
export function isEndpointId(value: unknown): value is string {
	return typeof value === "string" && HEX32.test(value);
}

export interface ConnectToken {
	endpointId: string;
	secret: string;
}

/** Receiver identity plus the shared secret that authorizes publishing to it. */
export function encodeToken(token: ConnectToken): string {
	if (!isEndpointId(token.endpointId) || !HEX32.test(token.secret)) {
		throw new Error("Invalid connection token");
	}
	return `bc_share_${token.endpointId}${token.secret}`;
}

export function parseToken(value: string): ConnectToken {
	const match = /^bc_share_([a-f0-9]{64})([a-f0-9]{64})$/.exec(value);
	if (!match) {
		throw new Error("Invalid connection token");
	}
	return { endpointId: match[1] as string, secret: match[2] as string };
}

/** The publisher proves it holds a receiver's token before that receiver reads anything else. */
export interface HelloMessage {
	type: "hello";
	secret: string;
	name: string;
	hostname: string;
}

export interface RunsMessage {
	type: "runs";
	runs: RunInput[];
}

/** Opened by the receiver on the publisher's connection, one per accepted local socket. */
export interface OpenMessage {
	type: "open";
	sessionId: string;
	targetId: string;
}

export function parseHello(value: unknown): HelloMessage {
	const message = record(value);
	if (
		message.type !== "hello" ||
		!HEX32.test(String(message.secret)) ||
		!text(message.name, 80) ||
		!text(message.hostname)
	) {
		throw new Error("Invalid connection handshake");
	}
	return {
		type: "hello",
		secret: message.secret as string,
		name: message.name,
		hostname: message.hostname,
	};
}

export function parseRuns(value: unknown): RunsMessage {
	const message = record(value);
	if (
		message.type !== "runs" ||
		!Array.isArray(message.runs) ||
		message.runs.length > 32
	) {
		throw new Error("Invalid run update");
	}
	const runs = message.runs.map(parseRun);
	if (new Set(runs.map((run) => run.sessionId)).size !== runs.length) {
		throw new Error("Invalid run update");
	}
	return { type: "runs", runs };
}

export function parseOpen(value: unknown): OpenMessage {
	const message = record(value);
	if (
		message.type !== "open" ||
		!text(message.sessionId) ||
		!text(message.targetId)
	) {
		throw new Error("Invalid stream request");
	}
	return {
		type: "open",
		sessionId: message.sessionId,
		targetId: message.targetId,
	};
}

/** Every reply is one of these two; an error carries a reason the receiver can show. */
export function parseReply(value: unknown): void {
	const message = record(value);
	if (message.type === "ok") {
		return;
	}
	throw new Error(
		text(message.message, 256) ? message.message : "Connection refused",
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

const LOOPBACK_SCHEMES = [
	"http:",
	"tcp:",
	"postgresql:",
	"redis:",
	"clickhouse:",
];

/**
 * Every address the bar can act on points at this computer.
 *
 * A remote publisher chooses the target's name and preset, so the receiver
 * derives the address itself; validating it again here is what keeps a
 * publisher from talking the menu into opening someone else's URL.
 */
export function parseLoopbackUrl(value: unknown, port: number): URL {
	if (!text(value, 2048)) {
		throw new Error("Invalid local address");
	}
	const url = new URL(value);
	// A database URL legitimately carries a path and query: the database name,
	// and the parameters TablePlus reads for connection name, environment and
	// TLS mode. An app address is built here and never has either.
	if (
		!LOOPBACK_SCHEMES.includes(url.protocol) ||
		url.hostname !== "127.0.0.1" ||
		Number(url.port) !== port ||
		url.hash ||
		(url.protocol === "http:" &&
			(url.pathname !== "/" || url.search || url.username || url.password))
	) {
		throw new Error("Invalid local address");
	}
	return url;
}

export function emptyDirectory(notice?: string): Directory {
	return {
		version: 1,
		configured: false,
		generatedAt: Date.now(),
		runs: [],
		...(notice === undefined ? {} : { notice }),
	};
}

export function parseDirectory(value: unknown): Directory {
	const directory = record(value);
	if (
		directory.version !== 1 ||
		typeof directory.configured !== "boolean" ||
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
		const id = `${run.publisherId}.${run.sessionId}`;
		if (!isEndpointId(run.publisherId) || ids.has(id)) {
			throw new Error("Invalid remote identity");
		}
		ids.add(id);
		for (const target of run.targets as RemoteTarget[]) {
			parseLoopbackUrl(target.url, target.port);
			if (target.tablePlusUrl !== undefined) {
				parseLoopbackUrl(target.tablePlusUrl, target.port);
			}
		}
	}
	return directory as unknown as Directory;
}
