import type { JWK } from "jose";
import {
	type DirectorySnapshot,
	directoryOrigin,
	isLoopback,
	MAX_BODY,
	parseDirectory,
	type Snapshot,
} from "./protocol";
export class DirectoryError extends Error {
	constructor(readonly status: number) {
		super(`Connection directory returned ${status}`);
	}
}
export class DirectoryClient {
	readonly origin: string;
	constructor(
		origin: string,
		private request: typeof fetch = fetch,
	) {
		this.origin = directoryOrigin(origin);
	}
	async call(
		path: string,
		secret?: string,
		method = "GET",
		body?: unknown,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const response = await this.request(`${this.origin}${path}`, {
			method,
			headers: {
				...(secret ? { authorization: `Bearer ${secret}` } : {}),
				...(body ? { "content-type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			redirect: "error",
			signal: AbortSignal.any([
				AbortSignal.timeout(8000),
				...(signal ? [signal] : []),
			]),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new DirectoryError(response.status);
		}
		if (Number(response.headers.get("content-length")) > MAX_BODY) {
			await response.body?.cancel();
			throw new Error("Directory response too large");
		}
		// Apply the same bounded streaming reader to responses as to requests.
		const { jsonBody } = await import("./protocol");
		return jsonBody(
			new Request(this.origin, { method: "POST", body: response.body }),
		);
	}
	async key(): Promise<JWK> {
		const key = await this.call("/v1/key");
		if (
			key.kty !== "OKP" ||
			key.crv !== "Ed25519" ||
			typeof key.x !== "string" ||
			key.d
		)
			throw new Error("Invalid directory signing key");
		return key as JWK;
	}
	path(recipient: string, suffix = ""): string {
		return `/v1/devices/${encodeURIComponent(recipient)}${suffix}`;
	}
	async create(recipient: string, owner: string, token: string) {
		await this.call(this.path(recipient), undefined, "POST", { owner, token });
	}
	async list(recipient: string, owner: string): Promise<DirectorySnapshot> {
		return parseDirectory(
			await this.call(this.path(recipient, "/sessions"), owner),
			recipient,
			isLoopback(new URL(this.origin)),
			Date.now(),
			this.origin,
		);
	}
	async publish(
		recipient: string,
		credential: string,
		sessionSecret: string,
		snapshot: Snapshot,
		signal?: AbortSignal,
	) {
		await this.call(
			this.path(recipient, `/sessions/${snapshot.sessionId}`),
			credential,
			"PUT",
			{ sessionSecret, snapshot },
			signal,
		);
	}
	async withdraw(recipient: string, session: string, credential: string) {
		await this.call(
			this.path(recipient, `/sessions/${session}`),
			credential,
			"DELETE",
		);
	}
	async access(
		recipient: string,
		owner: string,
		session: string,
		target: string,
	): Promise<string> {
		const result = await this.call(
			this.path(recipient, `/sessions/${session}/access`),
			owner,
			"POST",
			{ target },
		);
		if (
			typeof result.capability !== "string" ||
			result.capability.length > 8192
		)
			throw new Error("Invalid capability");
		return result.capability;
	}
}
