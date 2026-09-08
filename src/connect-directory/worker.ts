import { directoryOrigin, identifier } from "../core/connect/protocol";
import { type DeviceState, directoryRequest } from "./service";

interface State {
	storage: {
		get<T>(key: string): Promise<T | undefined>;
		put(key: string, value: unknown): Promise<void>;
	};
}
interface Env {
	CONNECT_ORIGIN: string;
	RECIPIENTS: {
		idFromName(name: string): unknown;
		get(id: unknown): { fetch(request: Request): Promise<Response> };
	};
	RATE_LIMITER: {
		limit(options: { key: string }): Promise<{ success: boolean }>;
	};
}
/** Serialize authorization and publication; application bytes never enter the Worker. */
export class RecipientDirectory {
	private pending: Promise<unknown> = Promise.resolve();
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
				return directoryRequest(request, {
					recipientId,
					origin: directoryOrigin(this.env.CONNECT_ORIGIN),
					storage: {
						load: () => this.state.storage.get<DeviceState>("device"),
						save: (state) => this.state.storage.put("device", state),
					},
				});
			});
		this.pending = operation;
		return operation;
	}
}
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health")
			return Response.json({
				service: "buncargo-connect",
				version: 1,
				transport: "tailcat",
			});
		const limiter = await env.RATE_LIMITER.limit({
			key: request.headers.get("cf-connecting-ip") ?? "unknown",
		});
		if (!limiter.success) return new Response("Rate limited", { status: 429 });
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
