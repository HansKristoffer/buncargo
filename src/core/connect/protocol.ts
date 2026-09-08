/** The public contract is deliberately independent of the local run registry. */
export const VERSION = 1;
export const LEASE_MS = 90_000;
export const ACCESS_SECONDS = 60;
export const MAX_BODY = 128 * 1024;
export const MAX_TARGETS = 64;
export const ID = /^[a-zA-Z0-9_-]{1,128}$/;
export const SECRET = /^[a-zA-Z0-9_-]{43}$/;
export const STATUSES = [
	"starting",
	"ready",
	"reused",
	"stopped",
	"failed",
] as const;
export type TargetStatus = (typeof STATUSES)[number];
export interface RemoteTarget {
	id: string;
	name: string;
	kind: "app" | "service";
	protocol: "http" | "tcp";
	status: TargetStatus;
	preset?: string;
}
export interface Snapshot {
	version: 1;
	sessionId: string;
	project: string;
	branch?: string | null;
	worktree?: string | null;
	primaryApp?: string | null;
	endpoint: string;
	revision: number;
	targets: RemoteTarget[];
}
export interface Registration extends Snapshot {
	transport?: "ready" | "connecting";
	recipientId: string;
	expiresAt: number;
}
export interface DirectorySnapshot {
	origin: string;
	version: 1;
	recipientId: string;
	generatedAt: number;
	runs: Registration[];
}
export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid connection document");
	return value as Record<string, unknown>;
}
export function label(value: unknown): value is string {
	return typeof value === "string" && value.length <= 256;
}
export function identifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		ID.test(value) &&
		!["__proto__", "constructor", "prototype"].includes(value)
	);
}
export function isLoopback(url: URL): boolean {
	return ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
}
export function directoryOrigin(input: string): string {
	const url = new URL(input);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname !== "/" && url.pathname !== "") ||
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && isLoopback(url)))
	)
		throw new Error(
			"Connection directory must be an HTTPS origin (HTTP is allowed only on loopback)",
		);
	return url.origin;
}
export function relayEndpoint(
	origin: string,
	recipient: string,
	session: string,
): string {
	if (!identifier(recipient) || !identifier(session))
		throw new Error("Invalid relay identity");
	return `${directoryOrigin(origin)}/v1/devices/${recipient}/sessions/${session}/relay`;
}
export function connectorEndpoint(input: unknown, local = false): string {
	if (typeof input !== "string" || input.length > 2048)
		throw new Error("Invalid relay endpoint");
	const url = new URL(input);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!(
			url.protocol === "https:" ||
			(local && url.protocol === "http:" && isLoopback(url))
		) ||
		!/^\/v1\/devices\/[A-Za-z0-9_-]{1,128}\/sessions\/[A-Za-z0-9_-]{1,128}\/relay$/.test(
			url.pathname,
		)
	)
		throw new Error("Invalid relay endpoint");
	return url.href;
}
export function parseSnapshot(input: unknown, local = false): Snapshot {
	const v = object(input);
	if (
		v.version !== VERSION ||
		!identifier(v.sessionId) ||
		!label(v.project) ||
		!Number.isSafeInteger(v.revision) ||
		Number(v.revision) < 0 ||
		!Array.isArray(v.targets) ||
		v.targets.length > MAX_TARGETS ||
		!v.targets.length
	)
		throw new Error("Invalid shared session");
	for (const field of ["branch", "worktree", "primaryApp"])
		if (v[field] != null && !label(v[field]))
			throw new Error("Invalid session label");
	const targets: RemoteTarget[] = v.targets.map((input) => {
		const t = object(input);
		if (
			!identifier(t.id) ||
			!label(t.name) ||
			!t.name ||
			!["app", "service"].includes(String(t.kind)) ||
			!["http", "tcp"].includes(String(t.protocol)) ||
			!STATUSES.includes(t.status as TargetStatus) ||
			(t.preset !== undefined && !identifier(t.preset))
		)
			throw new Error("Invalid shared target");
		return {
			id: t.id,
			name: t.name,
			kind: t.kind as RemoteTarget["kind"],
			protocol: t.protocol as RemoteTarget["protocol"],
			status: t.status as TargetStatus,
			...(t.preset ? { preset: t.preset as string } : {}),
		};
	});
	if (
		new Set(targets.map((t) => t.id)).size !== targets.length ||
		new Set(targets.map((t) => `${t.kind}:${t.name}`)).size !== targets.length
	)
		throw new Error("Duplicate shared target");
	if (
		v.primaryApp != null &&
		!targets.some((t) => t.kind === "app" && t.name === v.primaryApp)
	)
		throw new Error("Invalid primary app");
	return {
		version: 1,
		sessionId: v.sessionId,
		project: v.project,
		branch: v.branch as string | null,
		worktree: v.worktree as string | null,
		primaryApp: v.primaryApp as string | null,
		revision: v.revision as number,
		endpoint: connectorEndpoint(v.endpoint, local),
		targets,
	};
}
export function parseDirectory(
	input: unknown,
	recipient: string,
	local = false,
	now = Date.now(),
	expectedOrigin?: string,
): DirectorySnapshot {
	const v = object(input);
	if (
		v.version !== 1 ||
		v.recipientId !== recipient ||
		!Number.isFinite(v.generatedAt) ||
		Math.abs(Number(v.generatedAt) - now) > 120_000 ||
		!Array.isArray(v.runs) ||
		v.runs.length > 100
	)
		throw new Error("Invalid or stale connection directory");
	const origin = directoryOrigin(String(v.origin));
	if (expectedOrigin && origin !== directoryOrigin(expectedOrigin))
		throw new Error("Unexpected directory origin");
	const runs = v.runs.map((input) => {
		const r = object(input);
		if (
			r.recipientId !== recipient ||
			!["ready", "connecting"].includes(String(r.transport)) ||
			r.endpoint !== relayEndpoint(origin, recipient, String(r.sessionId)) ||
			!Number.isFinite(r.expiresAt) ||
			Number(r.expiresAt) <= now ||
			Number(r.expiresAt) > now + LEASE_MS + 5000
		)
			throw new Error("Invalid registration lease");
		return {
			...parseSnapshot(r, local),
			transport: r.transport as "ready" | "connecting",
			recipientId: recipient,
			expiresAt: Number(r.expiresAt),
		};
	});
	if (new Set(runs.map((r) => r.sessionId)).size !== runs.length)
		throw new Error("Duplicate session");
	return {
		version: 1,
		origin,
		recipientId: recipient,
		generatedAt: Number(v.generatedAt),
		runs,
	};
}
export function parseConnectionToken(token: string): {
	recipientId: string;
	secret: string;
} {
	const parts = token.split(".");
	if (
		parts.length !== 3 ||
		parts[0] !== "bc1" ||
		!identifier(parts[1]) ||
		!SECRET.test(parts[2])
	)
		throw new Error(
			"Invalid BUNCARGO_CONNECT_TOKENS; copy a connection token from BuncargoBar",
		);
	return { recipientId: parts[1], secret: parts[2] };
}
export function makeSecret(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"base64url",
	);
}
export async function hashSecret(secret: string): Promise<string> {
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
		),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");
}
export async function jsonBody(
	request: Request,
): Promise<Record<string, unknown>> {
	if (Number(request.headers.get("content-length")) > MAX_BODY)
		throw new Error("Document too large");
	const reader = request.body?.getReader();
	if (!reader) throw new Error("Missing document");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > MAX_BODY) throw new Error("Document too large");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return object(JSON.parse(new TextDecoder().decode(bytes)));
}
