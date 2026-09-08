import type { JWK } from "jose";
import { directoryOrigin, identifier } from "../core/connect/protocol";
import { RecipientRelay } from "./relay";
import { type DeviceState, directoryRequest } from "./service";

interface WorkerSocket {
	accept(): void;
	send(data: string | Uint8Array | ArrayBuffer): void;
	close(code?: number, reason?: string): void;
	addEventListener(
		type: "message",
		fn: (event: { data: string | ArrayBuffer }) => void,
	): void;
	addEventListener(type: "close" | "error", fn: () => void): void;
}
declare const WebSocketPair: { new (): { 0: WorkerSocket; 1: WorkerSocket } };
interface Storage {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
}
interface State {
	storage: Storage;
}
interface Env {
	CONNECT_SIGNING_JWK: string;
	CONNECT_ORIGIN: string;
	RECIPIENTS: {
		idFromName(name: string): unknown;
		get(id: unknown): { fetch(request: Request): Promise<Response> };
	};
	RATE_LIMITER: {
		limit(options: { key: string }): Promise<{ success: boolean }>;
	};
}
/** Explicit queue covers crypto/network awaits as well as storage operations. */
export class RecipientDirectory {
	private pending: Promise<unknown> = Promise.resolve();
	private relay?: RecipientRelay;
	constructor(
		private state: State,
		private env: Env,
	) {}
	fetch(request: Request): Promise<Response> {
		const operation = this.pending
			.catch(() => {})
			.then(async () => {
				const recipientId = new URL(request.url).pathname.split("/")[3];
				if (!identifier(recipientId))
					return new Response("Invalid recipient", { status: 400 });
				const origin = directoryOrigin(this.env.CONNECT_ORIGIN),
					key = JSON.parse(this.env.CONNECT_SIGNING_JWK) as JWK;
				this.relay ??= new RecipientRelay({
					recipient: recipientId,
					origin,
					key,
					load: () => this.state.storage.get<DeviceState>("device"),
				});
				const relay = this.relay;
				if (new URL(request.url).pathname.includes("/relay/")) {
					try {
						const admission = await relay.admit(request);
						const pair = new WebSocketPair();
						pair[1].accept();
						const listener = relay.open(admission, pair[1]);
						pair[1].addEventListener("message", (e) =>
							listener.message(e.data),
						);
						pair[1].addEventListener("close", () => listener.close());
						pair[1].addEventListener("error", () => listener.close());
						return new Response(null, {
							status: 101,
							webSocket: pair[0],
						} as ResponseInit);
					} catch {
						return new Response("Relay unavailable or unauthorized", {
							status: 403,
						});
					}
				}
				const response = await directoryRequest(request, {
					recipientId,
					relayReady: (s) => relay.ready(s),
					origin: directoryOrigin(this.env.CONNECT_ORIGIN),
					key: JSON.parse(this.env.CONNECT_SIGNING_JWK) as JWK,
					storage: {
						load: () => this.state.storage.get<DeviceState>("device"),
						save: (state) => this.state.storage.put("device", state),
					},
				});
				relay.reconcile(await this.state.storage.get<DeviceState>("device"));
				return response;
			});
		this.pending = operation;
		return operation;
	}
}
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health")
			return Response.json({ service: "buncargo-connect", version: 1 });
		const limiter = await env.RATE_LIMITER.limit({
			key: request.headers.get("cf-connecting-ip") ?? "unknown",
		});
		if (!limiter.success) return new Response("Rate limited", { status: 429 });
		if (url.pathname === "/v1/key" && request.method === "GET") {
			const key = JSON.parse(env.CONNECT_SIGNING_JWK) as JWK;
			return Response.json(
				{ kty: key.kty, crv: key.crv, x: key.x },
				{ headers: { "cache-control": "public, max-age=300" } },
			);
		}
		const match = url.pathname.match(
			/^\/v1\/devices\/([A-Za-z0-9_-]{1,128})(?:\/|$)/,
		);
		if (!match || !identifier(match[1]))
			return new Response("Not found", { status: 404 });
		return env.RECIPIENTS.get(env.RECIPIENTS.idFromName(match[1])).fetch(
			request,
		);
	},
};
