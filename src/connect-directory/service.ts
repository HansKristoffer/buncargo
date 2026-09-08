import type { JWK } from "jose";
import { signCapability } from "../core/connect/capability";
import {
	hashSecret,
	identifier,
	isLoopback,
	jsonBody,
	LEASE_MS,
	parseSnapshot,
	type Registration,
	relayEndpoint,
	SECRET,
} from "../core/connect/protocol";
export interface DeviceState {
	ownerHash: string;
	tokenHash: string;
	sessions: Record<
		string,
		{ hash: string; snapshot: Registration; withdrawn?: boolean }
	>;
}
export interface DirectoryStorage {
	load(): Promise<DeviceState | undefined>;
	save(state: DeviceState): Promise<void>;
}
export interface DirectoryOptions {
	storage: DirectoryStorage;
	key: JWK;
	origin: string;
	recipientId: string;
	now?: () => number;
	relayReady?: (session: string) => boolean;
}
/** Caller serializes requests for one recipient (Durable Object or local test adapter). */
export async function directoryRequest(
	request: Request,
	options: DirectoryOptions,
): Promise<Response> {
	const { storage, key, origin, recipientId } = options;
	const now = options.now?.() ?? Date.now();
	const fail = (status: number, error: string) =>
		Response.json(
			{ error },
			{ status, headers: { "cache-control": "no-store" } },
		);
	const ok = (data: unknown) =>
		Response.json(data, { headers: { "cache-control": "no-store" } });
	try {
		const path = new URL(request.url).pathname
			.split("/")
			.filter(Boolean)
			.slice(3);
		const action = path[0] ?? "";
		let state = await storage.load();
		const bearer = request.headers
			.get("authorization")
			?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
		const digest = bearer ? await hashSecret(bearer) : "";
		if (request.method === "POST" && !action) {
			const body = await jsonBody(request);
			if (!SECRET.test(String(body.owner)) || !SECRET.test(String(body.token)))
				return fail(400, "Invalid device credentials");
			const ownerHash = await hashSecret(String(body.owner));
			if (state)
				return state.ownerHash === ownerHash
					? ok({ recipientId })
					: fail(409, "Device already exists");
			state = {
				ownerHash,
				tokenHash: await hashSecret(String(body.token)),
				sessions: {},
			};
			await storage.save(state);
			return ok({ recipientId });
		}
		if (!state || !bearer) return fail(401, "Unauthorized");
		const owner = digest === state.ownerHash;
		if (action === "rotate" && request.method === "POST") {
			if (!owner) return fail(403, "Device authorization required");
			const body = await jsonBody(request);
			if (!SECRET.test(String(body.token)))
				return fail(400, "Invalid registration token");
			state.tokenHash = await hashSecret(String(body.token));
			if (body.revokeAll === true)
				for (const entry of Object.values(state.sessions))
					entry.withdrawn = true;
			await storage.save(state);
			return ok({ ok: true });
		}
		if (action !== "sessions") return fail(404, "Unknown endpoint");
		const session = path[1];
		if (!session && request.method === "GET") {
			if (!owner) return fail(403, "Device authorization required");
			return ok({
				version: 1,
				origin,
				recipientId,
				generatedAt: now,
				runs: Object.values(state.sessions)
					.filter((e) => !e.withdrawn && e.snapshot.expiresAt > now)
					.map((e) => ({
						...e.snapshot,
						transport: options.relayReady?.(e.snapshot.sessionId)
							? "ready"
							: "connecting",
					})),
			});
		}
		if (!identifier(session)) return fail(400, "Invalid session");
		const entry = Object.hasOwn(state.sessions, session)
			? state.sessions[session]
			: undefined;
		if (path[2] === "access" && request.method === "POST") {
			if (!owner) return fail(403, "Device authorization required");
			if (!entry || entry.withdrawn || entry.snapshot.expiresAt <= now)
				return fail(410, "Sharing expired or revoked");
			if (!options.relayReady?.(session))
				return fail(409, "Relay is connecting");
			const body = await jsonBody(request);
			const target = entry.snapshot.targets.find((t) => t.id === body.target);
			if (!target || !["ready", "reused"].includes(target.status))
				return fail(409, "Target is not ready");
			return ok({
				capability: await signCapability(
					key,
					origin,
					recipientId,
					session,
					target.id,
				),
			});
		}
		if (path.length > 2) return fail(404, "Unknown endpoint");
		if (request.method === "PUT") {
			const body = await jsonBody(request);
			const snapshot = parseSnapshot(
				body.snapshot,
				isLoopback(new URL(origin)),
			);
			if (
				snapshot.sessionId !== session ||
				snapshot.endpoint !== relayEndpoint(origin, recipientId, session) ||
				!SECRET.test(String(body.sessionSecret))
			)
				return fail(400, "Invalid session registration");
			const sessionHash = await hashSecret(String(body.sessionSecret));
			if (entry?.withdrawn) return fail(410, "Sharing revoked");
			// A token may create a registration, but never overwrite another publisher.
			if (entry && entry.hash !== sessionHash)
				return fail(403, "Session belongs to another publisher");
			if (entry && digest !== entry.hash && digest !== state.tokenHash)
				return fail(403, "Publisher authorization required");
			if (
				(!entry || entry.snapshot.expiresAt <= now) &&
				digest !== state.tokenHash
			)
				return fail(410, "Registration expired; register again");
			if (entry && snapshot.revision < entry.snapshot.revision)
				return fail(409, "Old snapshot revision");
			if (entry && snapshot.revision === entry.snapshot.revision) {
				const { recipientId: _, expiresAt: __, ...previous } = entry.snapshot;
				if (JSON.stringify(previous) !== JSON.stringify(snapshot))
					return fail(409, "Conflicting snapshot revision");
			}
			// Retain terminal IDs for a day, and bound all records including tombstones.
			for (const [id, value] of Object.entries(state.sessions))
				if (value.snapshot.expiresAt < now - 86400_000)
					delete state.sessions[id];
			if (!entry && Object.keys(state.sessions).length >= 100)
				return fail(429, "Recipient session limit reached");
			state.sessions[session] = {
				hash: sessionHash,
				snapshot: { ...snapshot, recipientId, expiresAt: now + LEASE_MS },
			};
			await storage.save(state);
			return ok({ expiresAt: now + LEASE_MS });
		}
		if (request.method === "DELETE") {
			if (!entry) return ok({ ok: true });
			if (!owner && digest !== entry.hash)
				return fail(403, "Registration authorization required");
			entry.withdrawn = true;
			await storage.save(state);
			return ok({ ok: true });
		}
		return fail(405, "Method not allowed");
	} catch {
		return fail(400, "Invalid connection request");
	}
}
